<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\Webhooks\Jobs\DeliverWebhook;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\Sending\SendResult;
use App\Domain\Developer\Webhooks\Sending\WebhookSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Delivery lifecycle (PHASE-8-4 §4.4, P84-9 … P84-13). Every method runs inside the delivery's tenant.
 *
 *  pending ─attempt─▶ succeeded | retrying ─(next_attempt_at)─▶ … ─▶ failed (after attempt 7)
 *
 * An attempt claims the row under a lock and pushes next_attempt_at out by a lease, so the job and the minute sweep
 * (`webhooks:dispatch-due`) never send the same delivery twice. No 2xx → `retrying` with the next P84-9 delay, then
 * `failed`. A disabled/deleted endpoint fails open deliveries with `endpoint_disabled`; a plan without api_webhooks
 * fails them with `plan` (P84-13).
 */
final class WebhookDeliveries
{
    public const USER_AGENT = 'Storeplix-Webhooks/1.0';

    public function __construct(
        private readonly TenantContext $context,
        private readonly WebhookSecrets $secrets,
    ) {}

    /** @param array<string, mixed> $payload the §4.2 body */
    public function create(WebhookEndpoint $endpoint, string $eventId, string $eventType, array $payload, ?string $subjectType = null, ?string $subjectId = null, ?string $label = null): WebhookDelivery
    {
        $delivery = new WebhookDelivery;
        $delivery->store_id = $endpoint->store_id;
        $delivery->endpoint_id = $endpoint->id;
        $delivery->event_id = $eventId;
        $delivery->event_type = $eventType;
        $delivery->subject_type = $subjectType;
        $delivery->subject_id = $subjectId;
        $delivery->subject_label = $label;
        $delivery->payload = $payload;
        $delivery->status = WebhookDelivery::PENDING;
        $delivery->attempts = 0;
        $delivery->next_attempt_at = now();
        $delivery->save();

        DeliverWebhook::dispatch($delivery->id)->forTenant($delivery->tenant_id)->afterCommit();

        return $delivery;
    }

    /** "Send test event": a `ping` with `data.object = {}`, normal lifecycle. */
    public function ping(WebhookEndpoint $endpoint): WebhookDelivery
    {
        $eventId = self::newId();
        $payload = WebhookPayloads::envelope($eventId, WebhookEventType::Ping, $endpoint->store_id, []);

        return $this->create($endpoint, $eventId, WebhookEventType::Ping->value, $payload);
    }

    /** §4.4 resend: a new row with the stored payload unchanged (same event id, new delivery id). */
    public function resend(WebhookDelivery $source): WebhookDelivery
    {
        /** @var WebhookEndpoint $endpoint */
        $endpoint = WebhookEndpoint::query()->findOrFail($source->endpoint_id);

        return $this->create($endpoint, $source->event_id, $source->event_type, $source->payload, $source->subject_type, $source->subject_id, $source->subject_label);
    }

    /** "Resend failed (n)": the latest failed delivery per (endpoint, event) of the last 24 h, max 100. */
    public function resendFailed(Store $store): int
    {
        $rows = $this->failedQuery($store)->orderBy('created_at')->orderBy('id')
            ->limit((int) config('webhooks_out.resend_failed_max', 100))->get();
        foreach ($rows as $row) {
            $this->resend($row);
        }

        return $rows->count();
    }

    public function failedCount(Store $store): int
    {
        return $this->failedQuery($store)->count();
    }

    /** Runs one attempt of a due delivery (job / sweep). */
    public function attempt(string $deliveryId): void
    {
        $claimed = DB::transaction(function () use ($deliveryId) {
            /** @var WebhookDelivery|null $d */
            $d = WebhookDelivery::query()->whereKey($deliveryId)->lockForUpdate()->first();
            if ($d === null || ! in_array($d->status, WebhookDelivery::OPEN, true)
                || ($d->next_attempt_at !== null && $d->next_attempt_at->isFuture())) {
                return null;
            }
            $endpoint = WebhookEndpoint::query()->find($d->endpoint_id);
            if ($endpoint === null || ! $endpoint->is_active) {
                $this->close($d, WebhookDelivery::ERROR_DISABLED);

                return null;
            }
            $tenant = $this->context->tenant();
            if ($tenant === null || ! FeatureGate::allows($tenant, Feature::ApiWebhooks)) {
                $this->close($d, WebhookDelivery::ERROR_PLAN);

                return null;
            }
            $d->next_attempt_at = now()->addSeconds((int) config('webhooks_out.attempt_lease_seconds', 120));
            $d->save();

            return [$d, $endpoint];
        });
        if ($claimed === null) {
            return;
        }
        [$delivery, $endpoint] = $claimed;

        $body = self::body($delivery->payload);
        $headers = $this->headers($delivery, $body);
        $result = app(WebhookSender::class)->send($endpoint->url, $headers, $body);

        $this->record($delivery->id, $endpoint->id, $result);
    }

    /** Fails every open delivery of an endpoint (disabled, auto-disabled). */
    public function failOpen(WebhookEndpoint $endpoint, string $errorCode): int
    {
        return WebhookDelivery::query()->where('endpoint_id', $endpoint->id)->whereIn('status', WebhookDelivery::OPEN)
            ->update(['status' => WebhookDelivery::FAILED, 'error_code' => $errorCode, 'next_attempt_at' => null]);
    }

    /** The exact bytes sent and signed (payload as stored). @param array<string, mixed> $payload */
    public static function body(array $payload): string
    {
        if (isset($payload['data']) && is_array($payload['data']) && ($payload['data']['object'] ?? null) === []) {
            $payload['data']['object'] = (object) [];
        }

        return (string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /** @return array<string, string> request headers of the next attempt (§4.2) */
    public function headers(WebhookDelivery $delivery, string $body, ?int $timestamp = null): array
    {
        return [
            'Content-Type' => 'application/json',
            'User-Agent' => self::USER_AGENT,
            'X-Storeplix-Event' => $delivery->event_type,
            'X-Storeplix-Delivery' => $delivery->id,
            WebhookSigner::HEADER => WebhookSigner::header($this->secrets->signing($delivery->store_id), $timestamp ?? now()->getTimestamp(), $body),
        ];
    }

    /** Headers as shown in the delivery log: the signature value is redacted. @return array<string, string> */
    public static function loggedHeaders(WebhookDelivery $delivery): array
    {
        $t = ($delivery->last_attempt_at ?? $delivery->created_at)?->getTimestamp() ?? 0;

        return [
            'Content-Type' => 'application/json',
            'User-Agent' => self::USER_AGENT,
            'X-Storeplix-Event' => $delivery->event_type,
            'X-Storeplix-Delivery' => $delivery->id,
            WebhookSigner::HEADER => 't='.$t.',v1=••••',
        ];
    }

    public static function newId(): string
    {
        return strtolower((string) Str::ulid());
    }

    public static function excerpt(?string $body): ?string
    {
        if ($body === null || $body === '') {
            return null;
        }
        $clean = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', mb_convert_encoding($body, 'UTF-8', 'UTF-8'));

        return mb_substr(mb_strcut($clean, 0, (int) config('webhooks_out.response_excerpt_bytes', 1024), 'UTF-8'), 0, 1024);
    }

    private function record(string $deliveryId, string $endpointId, SendResult $result): void
    {
        DB::transaction(function () use ($deliveryId, $endpointId, $result) {
            /** @var WebhookDelivery|null $d */
            $d = WebhookDelivery::query()->whereKey($deliveryId)->lockForUpdate()->first();
            if ($d === null) {
                return; // endpoint deleted meanwhile (cascade)
            }
            $now = now();
            $d->attempts++;
            $d->last_attempt_at = $now;
            $d->response_status = $result->status;
            $d->response_body_excerpt = self::excerpt($result->body);
            $d->error_code = $result->errorCode;
            $d->duration_ms = $result->durationMs;
            $delays = (array) config('webhooks_out.retry_delays_seconds', []);
            if ($result->ok) {
                $d->status = WebhookDelivery::SUCCEEDED;
                $d->next_attempt_at = null;
            } elseif ($d->status === WebhookDelivery::FAILED || $d->attempts > count($delays)) {
                $d->status = WebhookDelivery::FAILED;
                $d->next_attempt_at = null;
            } else {
                $d->status = WebhookDelivery::RETRYING;
                $d->next_attempt_at = $now->copy()->addSeconds((int) $delays[$d->attempts - 1]);
            }
            $d->save();

            $endpoint = WebhookEndpoint::query()->whereKey($endpointId);
            $endpoint->toBase()->update(['last_delivery_at' => $now, 'last_status' => $result->status]);
            if ($result->ok) {
                WebhookEndpoint::query()->whereKey($endpointId)->toBase()->update(['failing_since' => null]);
            } else {
                WebhookEndpoint::query()->whereKey($endpointId)->whereNull('failing_since')->toBase()->update(['failing_since' => $now]);
            }
        });
    }

    private function close(WebhookDelivery $d, string $errorCode): void
    {
        $d->status = WebhookDelivery::FAILED;
        $d->error_code = $errorCode;
        $d->next_attempt_at = null;
        $d->save();
    }

    /** @return Builder<WebhookDelivery> */
    private function failedQuery(Store $store)
    {
        return WebhookDelivery::query()
            ->where('store_id', $store->id)
            ->where('status', WebhookDelivery::FAILED)
            ->where('created_at', '>=', now()->subHours((int) config('webhooks_out.resend_failed_hours', 24)))
            ->whereNotExists(fn ($q) => $q->from('webhook_deliveries as later')
                ->whereColumn('later.endpoint_id', 'webhook_deliveries.endpoint_id')
                ->whereColumn('later.event_id', 'webhook_deliveries.event_id')
                ->where(fn ($w) => $w->whereColumn('later.created_at', '>', 'webhook_deliveries.created_at')
                    ->orWhere(fn ($same) => $same->whereColumn('later.created_at', '=', 'webhook_deliveries.created_at')
                        ->whereColumn('later.id', '>', 'webhook_deliveries.id'))));
    }
}
