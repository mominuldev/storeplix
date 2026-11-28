<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D §5.5: `CheckoutInput.tracking` → order_tracking_contexts, written inside the checkout transaction (before
 * the order's server events are built). Only when the store has a tracking integration (P89D-2 / S337); every value is
 * pattern-checked and dropped when invalid — checkout never fails on tracking. The shopper IP comes from the trusted
 * X-Storefront-Client-Ip only.
 */
final class TrackingContexts
{
    private const PATTERNS = [
        'fbp' => ['/^fb\.\d\.\d{10,16}\.\d{1,20}$/', 200],
        'fbc' => ['/^fb\.\d\.\d{10,16}\.[A-Za-z0-9_\-.]{1,450}$/', 500],
        'ttp' => ['/^[A-Za-z0-9_\-.]{1,200}$/', 200],
        'ttclid' => ['/^[A-Za-z0-9_\-.]{1,500}$/', 500],
        'ga_client_id' => ['/^[0-9]{1,20}\.[0-9]{1,20}$/', 100],
        'ga_session_id' => ['/^[0-9]{1,20}$/', 100],
    ];

    /** @return array<string, string|null> sanitised context (consent always set) */
    public static function sanitize(mixed $input): array
    {
        $input = is_array($input) ? $input : [];
        $consent = $input['consent'] ?? null;
        $out = ['consent' => in_array($consent, ['granted', 'denied', 'not_required'], true) ? $consent : 'denied'];
        foreach (self::PATTERNS as $key => [$pattern, $max]) {
            $value = $input[$key] ?? null;
            $out[$key] = is_string($value) && strlen($value) <= $max && preg_match($pattern, $value) === 1 ? $value : null;
        }
        $ua = $input['user_agent'] ?? null;
        $ua = is_string($ua) ? trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $ua) ?? '') : '';
        $out['user_agent'] = $ua === '' ? null : mb_substr($ua, 0, 400);

        return $out;
    }

    /** Called by checkout with the raw `tracking` input (absent = nothing saved). */
    public static function record(Order $order, mixed $input, ?string $clientIp): void
    {
        if (! is_array($input) || ! TrackingIntegrations::any($order->store_id)) {
            return;
        }
        $clean = self::sanitize($input);
        DB::table('order_tracking_contexts')->insertOrIgnore([
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => app(TenantContext::class)->requireId(),
            'store_id' => $order->store_id,
            'order_id' => $order->id,
            'consent' => $clean['consent'],
            'fbp' => $clean['fbp'], 'fbc' => $clean['fbc'], 'ttp' => $clean['ttp'], 'ttclid' => $clean['ttclid'],
            'ga_client_id' => $clean['ga_client_id'], 'ga_session_id' => $clean['ga_session_id'],
            'client_ip' => $clientIp !== null && filter_var($clientIp, FILTER_VALIDATE_IP) !== false ? $clientIp : null,
            'user_agent' => $clean['user_agent'],
            'created_at' => now(),
        ]);
    }
}
