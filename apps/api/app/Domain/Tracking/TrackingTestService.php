<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Tracking\Drivers\DeliveryResult;
use App\Domain\Tracking\Drivers\TrackingDrivers;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-9D P89D-19 / §5.8: "Send test event" (synchronous synthetic event, default `purchase` ৳1, with the test code
 * or GA4's validation server; logged `test: true`, never counted) and "Open shop in test mode" (signed 30-minute link,
 * Meta / TikTok, needs a saved test event code). Both audited. Test orders are not built (Q339).
 */
final class TrackingTestService
{
    public function __construct(
        private readonly TrackingDrivers $drivers,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /** @return array<string, mixed> TrackingTestResult */
    public function send(Store $store, StoreIntegration $integration, string $event, ?string $codeOverride): array
    {
        $providerName = TrackingEventNames::for($integration->provider, $event);
        if ($providerName === null || ! in_array($event, ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'], true)) {
            throw ValidationException::withMessages(['event' => [IntegrationProvider::LABELS[$integration->provider].' has no standard "'.$event.'" event.']]);
        }
        $code = $codeOverride ?? $integration->setting('test_event_code');
        $code = in_array($integration->provider, [IntegrationProvider::META_PIXEL, IntegrationProvider::TIKTOK_PIXEL], true) && is_string($code) && $code !== '' ? $code : null;
        $now = now();
        $row = new TrackingEvent;
        $row->forceFill([
            'store_id' => $store->id, 'store_integration_id' => $integration->id, 'provider' => $integration->provider,
            'event_name' => $event, 'provider_event_name' => $providerName, 'event_id' => 'test.'.strtolower((string) Str::ulid()),
            'channel' => TrackingEvent::SERVER, 'source' => 'test', 'test' => true, 'value_amount' => in_array($event, ['purchase', 'refund', 'view_item', 'add_to_cart'], true) ? 100 : null,
            'currency' => $store->currency, 'status' => TrackingEvent::PENDING, 'attempts' => 0, 'next_attempt_at' => null,
        ])->save();

        $payload = [
            'event_time' => $now->getTimestamp(),
            'event_source_url' => ($base = PaymentUrls::storefrontBase($store)) !== null ? $base.'/' : null,
            'transaction_id' => in_array($event, ['purchase', 'refund'], true) ? 'TEST-'.strtoupper(Str::random(6)) : null,
            'value_amount' => $row->value_amount,
            'currency' => $row->value_amount !== null ? $store->currency : null,
            'items' => $row->value_amount !== null ? [['id' => 'storeplix-test', 'name' => 'Test product', 'quantity' => 1, 'price_amount' => 100]] : [],
            'client_id' => 'storeplix.test',
        ];
        $skip = TrackingRecorder::skipReason($integration, null, false);
        $result = $skip === 'no_token' ? DeliveryResult::fail(DeliveryResult::AUTH)
            : $this->drivers->for($integration->provider)->send($integration, $row, array_filter($payload, fn ($v) => $v !== null && $v !== []), $code, debug: true);

        DB::table('tracking_events')->where('id', $row->id)->update([
            'status' => $result->delivered ? TrackingEvent::DELIVERED : TrackingEvent::FAILED, 'attempts' => 1, 'last_attempt_at' => now(),
            'http_status' => $result->httpStatus, 'error_code' => $result->errorCode, 'delivered_at' => $result->delivered ? now() : null, 'updated_at' => now(),
        ]);
        if ($result->errorCode === DeliveryResult::AUTH && $skip === null) {
            DB::transaction(fn () => IntegrationAttention::apply(StoreIntegration::query()->whereKey($integration->id)->lockForUpdate()->firstOrFail(), ['token_invalid' => null]));
        }
        $this->audit->log('integration.test_event_sent', null, ['provider' => $integration->provider, 'store_id' => $store->id, 'event' => $event,
            'event_id' => $row->event_id, 'delivered' => $result->delivered, 'error_code' => $result->errorCode]);

        return [
            'event_id' => $row->event_id,
            'event' => $event,
            'delivered' => $result->delivered,
            'http_status' => $result->httpStatus,
            'error_code' => $result->errorCode,
            'provider_message' => $result->providerMessage,
            'validation_messages' => $result->validationMessages,
        ];
    }

    /** @return array{url: string, expires_at: string} TrackingTestMode */
    public function testMode(Store $store, StoreIntegration $integration): array
    {
        $code = $integration->setting('test_event_code');
        if (! is_string($code) || $code === '') {
            throw ValidationException::withMessages(['test_event_code' => ['Save a test event code from '.(IntegrationProvider::LABELS[$integration->provider] ?? 'the provider').' first.']]);
        }
        $base = PaymentUrls::storefrontBase($store);
        if ($base === null || $store->status !== Store::STATUS_ACTIVE) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Test mode works on the live shop.");
        }
        $expires = now()->addMinutes((int) config('tracking.test_mode_minutes', 30));
        $token = TrackingTestMode::token($store->id, $integration->id, $expires->getTimestamp());
        $this->audit->log('integration.test_mode_started', null, ['provider' => $integration->provider, 'store_id' => $store->id, 'expires_at' => $expires->toIso8601ZuluString()]);

        return ['url' => $base.'/?sp_test='.$token, 'expires_at' => $expires->toIso8601ZuluString()];
    }
}
