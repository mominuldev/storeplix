<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use InvalidArgumentException;

/**
 * Renders the fixed order SMS templates (resources/sms/{bn,en}.php). Every variable is reduced to one line: control
 * characters and URLs stripped, whitespace collapsed, shop and names truncated (S13).
 */
final class SmsTemplates
{
    public const EVENTS = ['order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link'];

    /** PHASE-8-8 P88-13: the shopper checkout code (not an order event; vars `shop`, `code`). */
    public const CHECKOUT_OTP = 'checkout_otp';

    /**
     * PHASE-8-8D P88D-12: the till SMS receipt (vars `shop`, `number`, `total`, `method`, `footer`). Not an order-status
     * event: never sent by the order notifier or the store SMS toggles, only when the cashier ticks it.
     */
    public const POS_RECEIPT = 'pos_receipt';

    /** `sms_messages.purpose` values counted against the `sms_per_month` allowance (P5-26 + P88-13 + P88D-12). */
    public const COUNTED = [...self::EVENTS, self::CHECKOUT_OTP, self::POS_RECEIPT];

    public const LABELS = [
        'order_placed' => 'Order received',
        'order_confirmed' => 'Order confirmed',
        'order_shipped' => 'Shipped',
        'order_cancelled' => 'Order cancelled',
        'order_updated' => 'Order updated',
        'payment_link' => 'Payment link',
        self::POS_RECEIPT => 'Receipt',
    ];

    /** 3 UCS-2 segments (Bangla); English GSM-7 texts are far below this. */
    public const MAX_CHARS = 201;

    /**
     * Renders a template; when a long shop name, buyer name or host would push it past 3 segments, the free-text
     * variables (receipt footer first, then name, carrier, shop) are shortened, never the order number, amount or
     * tracking link.
     *
     * @param  array<string, string|int|null>  $vars
     */
    public static function render(string $event, string $language, array $vars): string
    {
        $templates = require resource_path('sms/'.($language === 'en' ? 'en' : 'bn').'.php');
        $template = $templates[$event] ?? throw new InvalidArgumentException("Unknown SMS event {$event}.");
        $vars = array_map(fn ($v) => (string) $v, $vars);
        $minimum = ['footer' => 0, 'first_name' => 0, 'carrier' => 8, 'shop' => 12];
        for ($i = 0; $i < 10; $i++) {
            $text = self::fill($template, $vars);
            $over = mb_strlen($text) - self::MAX_CHARS;
            if ($over <= 0) {
                return $text;
            }
            foreach ($minimum as $key => $min) {
                if (! isset($vars[$key]) || ! str_contains($template, '{'.$key.'}') || mb_strlen($vars[$key]) <= $min) {
                    continue;
                }
                $cut = min($over, mb_strlen($vars[$key]) - $min);
                $vars[$key] = trim(mb_substr($vars[$key], 0, mb_strlen($vars[$key]) - $cut));
                $over -= $cut;
                if ($over <= 0) {
                    break;
                }
            }
        }

        return self::fill($template, $vars);
    }

    /** @param array<string, string> $vars */
    private static function fill(string $template, array $vars): string
    {
        $replace = [];
        foreach ($vars as $key => $value) {
            $replace['{'.$key.'}'] = $value;
        }

        return trim((string) preg_replace('/\s+/u', ' ', strtr($template, $replace)));
    }

    /** @return array<string, string> */
    public static function varsFor(Order $order, Store $store, ?string $carrier = null): array
    {
        $host = $store->primaryDomain?->hostname;

        return [
            'first_name' => self::clean(explode(' ', trim($order->customer_name))[0] ?? '', 20),
            'shop' => self::clean($store->name, 40),
            'number' => $order->number,
            'total' => Money::plain($order->total_amount),
            'due' => Money::plain($order->dueAmount()),
            'carrier' => self::clean($carrier ?? '', 30) ?: 'courier',
            'track_url' => $host ? "https://{$host}/track" : '',
        ];
    }

    /** One line, no control characters or links, at most $max characters. */
    public static function clean(string $value, int $max): string
    {
        $value = (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value);
        $value = (string) preg_replace('~(https?://|www\.)\S*~iu', '', $value);
        $value = trim((string) preg_replace('/\s+/u', ' ', $value));

        return mb_substr($value, 0, $max);
    }
}
