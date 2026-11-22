<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Orders\OrderPlacementService;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;

/** StoreCommerceSettings (§6) read model. */
final class StoreCommerce
{
    public const SMS_DEFAULTS = ['order_placed' => true, 'order_confirmed' => false, 'order_shipped' => true, 'order_cancelled' => true, 'order_updated' => true, 'payment_link' => true];

    /** @return array<string, mixed> */
    public static function present(Store $store, StoreSetting $settings): array
    {
        $prefix = OrderPlacementService::prefix($store, $settings);
        $current = StoreCounter::current($store->id, StoreCounter::ORDERS);
        $toggles = (array) ($settings->customer_sms ?? []);

        return [
            'checkout' => ['cod_enabled' => (bool) ($settings->cod_enabled ?? true), 'cod_advance' => $settings->cod_advance === 'delivery_charge' ? 'delivery_charge' : 'none'],
            'tax' => [
                'display' => $settings->tax_display === 'included' ? 'included' : 'none',
                'rate_bps' => (int) ($settings->tax_rate_bps ?? 0),
                'bin' => $settings->tax_bin,
            ],
            'invoice' => ['footer' => $settings->invoice_footer],
            'order_prefix' => $prefix,
            'next_order_number' => $prefix.'-'.($current === null ? StoreCounter::START[StoreCounter::ORDERS] : $current + 1),
            'notifications' => [
                'new_order_email' => (bool) ($settings->notify_new_order_email ?? true),
                'sms_language' => $settings->sms_language === 'en' ? 'en' : 'bn',
                // Key order of SMS_DEFAULTS on every database (Postgres jsonb reorders keys).
                'customer_sms' => array_map(fn (string $event) => (bool) ($toggles[$event] ?? self::SMS_DEFAULTS[$event]), array_combine(array_keys(self::SMS_DEFAULTS), array_keys(self::SMS_DEFAULTS))),
            ],
        ];
    }
}
