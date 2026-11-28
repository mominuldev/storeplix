<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Models\SmsTemplate;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use InvalidArgumentException;

/**
 * Renders the order SMS templates. Every variable is reduced to one line: control characters and URLs stripped,
 * whitespace collapsed, shop and names truncated (S13).
 *
 * PHASE-8-9A §4.4 (P89A-11, P89A-17): the body is the store's custom `sms_templates` row for (key, language) when one
 * exists, else the default file resources/sms/{bn,en}.php (unchanged, byte for byte). With an approved masked sender
 * ID a body that starts with the literal `{shop}: ` loses that prefix. Rendering (fill, S13, shortening of the
 * free-text vars) is the same for default and custom bodies; the shortening stops at ≤ 3 SMS parts AND ≤ 201
 * characters (the 8.8d limit, so default texts stay byte for byte; a still-longer custom text is sent as is and charged
 * by its real parts).
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
    public const COUNTED = [...self::EVENTS, self::CHECKOUT_OTP, self::POS_RECEIPT, 'sms_test', 'inbox_verify', 'inbox_reply']; // + PHASE-8-9A P89A-2 test SMS, + PHASE-8-8E inbox SMS

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

    /** PHASE-8-9A P89A-8 / P89A-11: rendered texts aim at ≤ 3 parts. */
    public const MAX_PARTS = 3;

    /** PHASE-8-9A P89A-7: editable keys (the 6 order events + the POS receipt), in SMS_TEMPLATE_EVENTS order. */
    public const EDITABLE = [...self::EVENTS, self::POS_RECEIPT];

    public const LANGUAGES = ['bn', 'en'];

    /** PHASE-8-9A P89A-17: the literal prefix dropped with a masked sender ID. */
    public const SHOP_PREFIX = '{shop}: ';

    /**
     * Renders a template; when a long shop name, buyer name or host would push it past 3 segments, the free-text
     * variables (receipt footer first, then name, carrier, shop) are shortened, never the order number, amount or
     * tracking link. `$store` (PHASE-8-9A §4.4) selects the store's custom body and its sender; null = the default body
     * with the shared sender (unchanged 8.8d behaviour).
     *
     * @param  array<string, string|int|null>  $vars
     */
    public static function render(string $event, string $language, array $vars, ?Store $store = null): string
    {
        $template = self::bodyFor($event, $language, $store);
        if ($store !== null && SmsSender::for($store) !== null) {
            $template = self::dropShopPrefix($template);
        }

        return self::renderBody($template, $vars);
    }

    /** Fill + S13 + shortening of an already chosen body (custom or default, prefix rule applied). @param array<string, string|int|null> $vars */
    public static function renderBody(string $template, array $vars): string
    {
        $vars = array_map(fn ($v) => (string) $v, $vars);
        $minimum = ['footer' => 0, 'first_name' => 0, 'carrier' => 8, 'shop' => 12];
        for ($i = 0; $i < 10; $i++) {
            $text = self::fill($template, $vars);
            $over = self::over($text);
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

    /** Characters over the target: > 201 characters, or (GSM-7 extension characters, emoji) more than 3 parts. */
    private static function over(string $text): int
    {
        $over = mb_strlen($text) - self::MAX_CHARS;
        $count = SmsParts::count($text);
        if ($count['parts'] > self::MAX_PARTS) {
            $max = $count['encoding'] === SmsParts::GSM7 ? 153 * self::MAX_PARTS : 67 * self::MAX_PARTS;
            $over = max($over, $count['units'] - $max);
        }

        return $over;
    }

    /** The default body (resources/sms/{bn,en}.php) of a key. */
    public static function defaultBody(string $event, string $language): string
    {
        $templates = require resource_path('sms/'.($language === 'en' ? 'en' : 'bn').'.php');

        return $templates[$event] ?? throw new InvalidArgumentException("Unknown SMS event {$event}.");
    }

    /** The store's custom body for an editable key, else the default. Call inside the store's tenant context. */
    public static function bodyFor(string $event, string $language, ?Store $store): string
    {
        $language = $language === 'en' ? 'en' : 'bn';
        if ($store !== null && in_array($event, self::EDITABLE, true)) {
            $custom = SmsTemplate::query()->where('store_id', $store->id)->where('key', $event)->where('language', $language)->value('body');
            if (is_string($custom) && $custom !== '') {
                return $custom;
            }
        }

        return self::defaultBody($event, $language);
    }

    public static function dropShopPrefix(string $body): string
    {
        return str_starts_with($body, self::SHOP_PREFIX) ? substr($body, strlen(self::SHOP_PREFIX)) : $body;
    }

    /** @param array<string, string> $vars */
    public static function fill(string $template, array $vars): string
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
