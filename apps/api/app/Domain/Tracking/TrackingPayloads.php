<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Orders\Models\Order;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Stores\Models\Store;
use App\Domain\Tracking\Models\OrderTrackingContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9D P89D-13 / P89D-21: the delivery payload of a server event. Values in minor units (converted at the edge by
 * the driver); customer data hashed (UserDataHasher) only when the integration sends customer data AND consent allows;
 * client context (IP, UA, fbp, fbc, ttp, ttclid, GA ids) from order_tracking_contexts. Never a secret.
 *
 * Shape: {event_time, event_source_url, transaction_id?, value_amount?, currency?, items[{id, name, quantity,
 * price_amount}], user{em, ph, ph_meta, fn, ln, ct, country, external_id}, client{ip, ua, fbp, fbc, ttp, ttclid,
 * ga_client_id, ga_session_id}, client_id}
 */
final class TrackingPayloads
{
    /** @return array<string, mixed> */
    public static function purchase(StoreIntegration $integration, Order $order, ?OrderTrackingContext $context): array
    {
        $value = (int) $order->total_amount;
        if (! (bool) $integration->setting('include_delivery_charge', false)) {
            $value = max(0, $value - (int) $order->shipping_amount);
        }
        $items = DB::table('order_items')->where('order_id', $order->id)->orderBy('id')
            ->get(['variant_id', 'product_name', 'variant_title', 'quantity', 'unit_price_amount'])
            ->map(fn ($i) => [
                'id' => (string) ($i->variant_id ?? 'line'),
                'name' => trim($i->product_name.(($i->variant_title ?? '') !== '' && $i->variant_title !== 'Default' ? ' - '.$i->variant_title : '')),
                'quantity' => (int) $i->quantity,
                'price_amount' => (int) $i->unit_price_amount,
            ])->values()->all();

        return self::base($integration, $order->store_id, '/orders/thank-you', $context, $order) + [
            'transaction_id' => $order->number,
            'value_amount' => $value,
            'currency' => $order->currency,
            'items' => $items,
        ];
    }

    /** @return array<string, mixed> */
    public static function refund(StoreIntegration $integration, Order $order, int $amount, ?OrderTrackingContext $context): array
    {
        return self::base($integration, $order->store_id, null, $context, $order) + [
            'transaction_id' => $order->number,
            'value_amount' => $amount,
            'currency' => $order->currency,
        ];
    }

    /**
     * @param  array<string, mixed>  $client  beacon context (ip, ua, fbp, …)
     * @param  list<array{id: string, name: string, quantity: int, price_amount: int}>  $items
     * @return array<string, mixed>
     */
    public static function browser(string $storeId, string $path, array $client, ?int $value, ?string $currency, array $items, int $eventTime): array
    {
        return array_filter([
            'event_time' => $eventTime,
            'event_source_url' => self::url($storeId, $path),
            'value_amount' => $value,
            'currency' => $value !== null ? $currency : null,
            'items' => $items !== [] ? $items : null,
            'client' => array_filter($client, fn ($v) => $v !== null && $v !== ''),
        ], fn ($v) => $v !== null && $v !== []);
    }

    /** @return array<string, mixed> */
    private static function base(StoreIntegration $integration, string $storeId, ?string $path, ?OrderTrackingContext $context, Order $order): array
    {
        $consentOk = ! (bool) $integration->setting('wait_for_consent', false) || $context?->consent === 'granted';
        $user = (bool) $integration->setting('send_customer_data', true) && $consentOk
            ? UserDataHasher::forOrder($order->customer_email, $order->customer_phone, $order->customer_name, (string) ($order->shipping_address['district'] ?? ''), $order->customer_id)
            : [];
        $client = $context === null ? [] : array_filter([
            'ip' => $context->client_ip, 'ua' => $context->user_agent, 'fbp' => $context->fbp, 'fbc' => $context->fbc,
            'ttp' => $context->ttp, 'ttclid' => $context->ttclid, 'ga_client_id' => $context->ga_client_id, 'ga_session_id' => $context->ga_session_id,
        ], fn ($v) => $v !== null && $v !== '');

        return array_filter([
            'event_time' => now()->getTimestamp(),
            'event_source_url' => self::url($storeId, $path ?? '/'),
            'user' => $user,
            'client' => $client,
            // GA4 / GTM need a client id: `_ga` when known, else a stable id per order (P89D §5.2).
            'client_id' => $context?->ga_client_id ?? 'sp.'.$order->id,
        ], fn ($v) => $v !== null && $v !== []);
    }

    private static function url(string $storeId, string $path): ?string
    {
        // Looked up per payload (no process cache): a long-lived queue worker must see a new primary domain at once.
        $store = Store::query()->find($storeId);
        $base = $store !== null ? PaymentUrls::storefrontBase($store) : null;

        return $base !== null ? $base.'/'.ltrim(mb_substr($path, 0, 300), '/') : null;
    }
}
