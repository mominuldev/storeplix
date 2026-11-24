<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\Sending\WebhookUrlGuard;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * Endpoint management (PHASE-8-4 §6.1). Writes need `api_webhooks` (402, P84-13); ≤ 5 per store (422 limit_reached,
 * P84-14); URLs pass the SSRF guard on save (422 webhook_url_not_allowed, S107). Audited per §6.1.
 */
final class WebhookEndpoints
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly WebhookUrlGuard $guard,
        private readonly WebhookSecrets $secrets,
        private readonly WebhookDeliveries $deliveries,
        private readonly AuditLogger $audit,
    ) {}

    public function assertFeature(): void
    {
        $tenant = $this->context->tenant();
        if ($tenant !== null) {
            FeatureGate::assertAllows($tenant, Feature::ApiWebhooks);
        }
    }

    /** @param array{url: string, events: list<string>, description?: string|null} $input */
    public function create(Store $store, array $input): WebhookEndpoint
    {
        $this->guard->check($input['url']);
        $this->secrets->ensure($store);

        return DB::transaction(function () use ($store, $input) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $max = (int) config('webhooks_out.max_endpoints_per_store', 5);
            if (WebhookEndpoint::query()->where('store_id', $store->id)->count() >= $max) {
                throw new ApiException(422, 'limit_reached', "A store can have at most {$max} webhook endpoints.", ['url' => ["A store can have at most {$max} webhook endpoints."]]);
            }
            $endpoint = new WebhookEndpoint;
            $endpoint->store_id = $store->id;
            $endpoint->url = $input['url'];
            $endpoint->description = $input['description'] ?? null;
            $endpoint->events = self::ordered($input['events']);
            $endpoint->is_active = true;
            $endpoint->save();
            $this->audit->log('webhook_endpoint.created', $endpoint, ['events' => $endpoint->events]);

            return $endpoint;
        });
    }

    /** @param array{url?: string, events?: list<string>, description?: string|null, is_active?: bool} $input */
    public function update(WebhookEndpoint $endpoint, array $input): WebhookEndpoint
    {
        if (array_key_exists('url', $input)) {
            $this->guard->check($input['url']);
        }

        return DB::transaction(function () use ($endpoint, $input) {
            /** @var WebhookEndpoint $locked */
            $locked = WebhookEndpoint::query()->whereKey($endpoint->id)->lockForUpdate()->firstOrFail();
            if (array_key_exists('url', $input)) {
                $locked->url = $input['url'];
            }
            if (array_key_exists('events', $input)) {
                $locked->events = self::ordered($input['events']);
            }
            if (array_key_exists('description', $input)) {
                $locked->description = $input['description'];
            }
            $disabling = false;
            if (array_key_exists('is_active', $input) && $input['is_active'] !== $locked->is_active) {
                $locked->is_active = $input['is_active'];
                $locked->disabled_reason = $input['is_active'] ? null : WebhookEndpoint::DISABLED_MANUAL;
                $locked->failing_since = null;
                $disabling = ! $input['is_active'];
            }
            $changes = array_keys($locked->getDirty());
            $locked->save();
            if ($disabling) {
                $this->deliveries->failOpen($locked, WebhookDelivery::ERROR_DISABLED);
            }
            if ($changes !== []) {
                $this->audit->log('webhook_endpoint.updated', $locked, ['changes' => array_values(array_diff($changes, ['updated_at']))]);
            }

            return $locked;
        });
    }

    public function delete(WebhookEndpoint $endpoint): void
    {
        DB::transaction(function () use ($endpoint) {
            $this->audit->log('webhook_endpoint.deleted', $endpoint, ['url_host' => parse_url($endpoint->url, PHP_URL_HOST)]);
            $endpoint->delete();
        });
    }

    public function test(WebhookEndpoint $endpoint): WebhookDelivery
    {
        if (! $endpoint->is_active) {
            throw new ApiException(409, 'webhook_endpoint_disabled', 'Enable this endpoint before sending a test event.');
        }

        return $this->deliveries->ping($endpoint);
    }

    /** P84-11: disable endpoints failing for 72 h; returns how many. Call inside the tenant. */
    public function autoDisable(): int
    {
        $cutoff = now()->subHours((int) config('webhooks_out.auto_disable_hours', 72));
        $count = 0;
        foreach (WebhookEndpoint::query()->where('is_active', true)->whereNotNull('failing_since')->where('failing_since', '<=', $cutoff)->get() as $endpoint) {
            DB::transaction(function () use ($endpoint, &$count) {
                /** @var WebhookEndpoint|null $locked */
                $locked = WebhookEndpoint::query()->whereKey($endpoint->id)->lockForUpdate()->first();
                if ($locked === null || ! $locked->is_active || $locked->failing_since === null) {
                    return;
                }
                $since = $locked->failing_since;
                $locked->is_active = false;
                $locked->disabled_reason = WebhookEndpoint::DISABLED_FAILING;
                $locked->save();
                $this->deliveries->failOpen($locked, WebhookDelivery::ERROR_DISABLED);
                $this->audit->log('webhook_endpoint.auto_disabled', $locked, ['failing_since' => $since->toIso8601ZuluString()], system: true);
                $count++;
            });
        }

        return $count;
    }

    /** @param list<string> $events @return list<string> catalogue order, unique */
    public static function ordered(array $events): array
    {
        return array_values(array_intersect(WebhookEventType::subscribableValues(), $events));
    }
}
