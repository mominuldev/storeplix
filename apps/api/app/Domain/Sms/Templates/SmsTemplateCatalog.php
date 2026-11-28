<?php

declare(strict_types=1);

namespace App\Domain\Sms\Templates;

use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Pos\PosReceipts;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsTemplate;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-9A §7 (P89A-7, P89A-8, S214): the template keys, their merge fields, the body rules shared by PUT and preview,
 * the §7.3 sample render and the SmsTemplate presenter. Call inside the store's tenant context.
 */
final class SmsTemplateCatalog
{
    /** Every listed key: the 7 editable ones (SMS_TEMPLATE_EVENTS order) then the read-only checkout code. */
    public const KEYS = [...SmsTemplates::EDITABLE, SmsTemplates::CHECKOUT_OTP];

    public const LABELS = [
        'order_placed' => 'Order received',
        'order_confirmed' => 'Order confirmed',
        'order_shipped' => 'Shipped',
        'order_cancelled' => 'Order cancelled',
        'order_updated' => 'Order updated',
        'payment_link' => 'Payment link',
        'pos_receipt' => 'POS receipt',
        'checkout_otp' => 'Checkout code',
    ];

    /** §7.1 merge fields per key. */
    public const MERGE_FIELDS = [
        'order_placed' => ['first_name', 'shop', 'number', 'total', 'due', 'track_url'],
        'order_confirmed' => ['first_name', 'shop', 'number', 'total', 'due', 'track_url'],
        'order_shipped' => ['first_name', 'shop', 'number', 'total', 'due', 'carrier', 'track_url'],
        'order_cancelled' => ['first_name', 'shop', 'number', 'total'],
        'order_updated' => ['first_name', 'shop', 'number', 'total', 'due', 'track_url'],
        'payment_link' => ['first_name', 'shop', 'number', 'amount', 'url'],
        'pos_receipt' => ['first_name', 'shop', 'number', 'total', 'method', 'footer'],
        'checkout_otp' => ['shop', 'code'],
    ];

    public const REQUIRED_FIELDS = ['payment_link' => ['url']];

    public const MAX_LENGTH = 480;

    public static function exists(string $key): bool
    {
        return in_array($key, self::KEYS, true);
    }

    public static function editable(string $key): bool
    {
        return in_array($key, SmsTemplates::EDITABLE, true);
    }

    /** 404 for an unknown key, 422 `sms_template_read_only` for the checkout code. */
    public static function assertEditable(string $key): void
    {
        if (! self::exists($key)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if (! self::editable($key)) {
            throw new ApiException(422, 'sms_template_read_only', 'The checkout code text is managed by the Fake order guard and can’t be edited.');
        }
    }

    /** Trim and collapse line breaks to spaces (what fill() sends anyway). */
    public static function normalise(string $body): string
    {
        return trim((string) preg_replace('/[\r\n]+/u', ' ', $body));
    }

    /**
     * P89A-8: the body rules. Returns the normalised body and its sample preview.
     *
     * @return array{body: string, preview: array{text: string, parts: int, encoding: string, characters: int}}
     */
    public static function validate(Store $store, string $key, string $language, string $body): array
    {
        self::assertEditable($key);
        $body = self::normalise($body);
        $length = mb_strlen($body);
        if ($length < 1 || $length > self::MAX_LENGTH) {
            throw ValidationException::withMessages(['body' => [$length < 1 ? 'Write a message.' : 'The message may not be longer than 480 characters.']]);
        }
        if (preg_match('~https?://|www\.~iu', $body) === 1) {
            throw new ApiException(422, 'sms_template_link_not_allowed', 'Links can’t be typed into an SMS template. Use the merge fields instead.');
        }
        preg_match_all('/\{([^{}]*)\}/u', $body, $m);
        $used = array_values(array_unique($m[1]));
        $unknown = array_values(array_diff($used, self::MERGE_FIELDS[$key]));
        if ($unknown !== []) {
            throw new ApiException(422, 'sms_template_unknown_merge_field', 'This message uses merge fields that don’t exist for it: {'.implode('}, {', $unknown).'}.', ['fields' => $unknown]);
        }
        $missing = array_values(array_diff(self::REQUIRED_FIELDS[$key] ?? [], $used));
        if ($missing !== []) {
            throw new ApiException(422, 'sms_template_missing_merge_field', 'This message must keep {'.implode('}, {', $missing).'}.', ['fields' => $missing]);
        }
        $preview = self::preview($store, $key, $language, $body);
        $max = (int) config('sms.template_max_parts', SmsTemplates::MAX_PARTS);
        if ($preview['parts'] > $max) {
            throw new ApiException(422, 'sms_template_too_long', "Too long for one message. Keep it within {$max} parts.", ['parts' => $preview['parts'], 'max_parts' => $max]);
        }

        return ['body' => $body, 'preview' => $preview];
    }

    /**
     * §7.3: the body rendered with sample values and the store's current sender (prefix rule).
     *
     * @return array{text: string, parts: int, encoding: string, characters: int}
     */
    public static function preview(Store $store, string $key, string $language, string $body): array
    {
        if (SmsSender::for($store) !== null) {
            $body = SmsTemplates::dropShopPrefix($body);
        }
        $text = SmsTemplates::renderBody($body, self::sampleVars($store, $language));
        $count = SmsParts::count($text);

        return ['text' => $text, 'parts' => $count['parts'], 'encoding' => $count['encoding'], 'characters' => $count['units']];
    }

    /** @return array<string, string> §7.3 sample values */
    public static function sampleVars(Store $store, string $language): array
    {
        $store->loadMissing('primaryDomain');
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();
        $host = $store->primaryDomain?->hostname ?? 'shop.storeplix.com';
        $footer = PosReceipts::template($store->id)['footer_text'] ?? null;
        $bn = $language === 'bn';

        return [
            'first_name' => $bn ? 'নাসরিন' : 'Nasrin',
            'shop' => SmsTemplates::clean($store->name, 40),
            'number' => OrderPlacementService::prefix($store, $settings).'-1042',
            'total' => '1,770',
            'due' => '1,770',
            'carrier' => 'Steadfast',
            'track_url' => "https://{$host}/track",
            'amount' => '500',
            'url' => "https://{$host}/pay/Ab12Cd34Ef56",
            'method' => $bn ? 'নগদ' : 'Cash',
            'footer' => is_string($footer) && trim($footer) !== '' ? SmsTemplates::clean($footer, 120) : 'Thank you',
            'code' => '482913',
        ];
    }

    /** @return array<string, bool> the store's customer_sms toggles with the StoreSetting defaults */
    public static function toggles(Store $store): array
    {
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();
        $defaults = json_decode((string) ((new StoreSetting)->getAttributes()['customer_sms'] ?? '{}'), true) ?: [];

        return array_map('boolval', ((array) ($settings?->customer_sms ?? [])) + $defaults);
    }

    /** @return list<array<string, mixed>> the 16 SmsTemplate rows */
    public static function all(Store $store): array
    {
        $custom = SmsTemplate::query()->where('store_id', $store->id)->with('updatedBy')->get()
            ->keyBy(fn (SmsTemplate $t) => $t->key.'.'.$t->language);
        $toggles = self::toggles($store);
        $rows = [];
        foreach (self::KEYS as $key) {
            foreach (SmsTemplates::LANGUAGES as $language) {
                $rows[] = self::present($store, $key, $language, $custom->get($key.'.'.$language), $toggles);
            }
        }

        return $rows;
    }

    /**
     * SmsTemplate (openapi 1.23.0).
     *
     * @param  array<string, bool>|null  $toggles
     * @return array<string, mixed>
     */
    public static function present(Store $store, string $key, string $language, ?SmsTemplate $row, ?array $toggles = null): array
    {
        $toggles ??= self::toggles($store);
        $default = SmsTemplates::defaultBody($key, $language);
        $body = $row?->body ?? $default;

        return [
            'key' => $key,
            'language' => $language,
            'label' => self::LABELS[$key],
            'body' => $body,
            'default_body' => $default,
            'is_custom' => $row !== null,
            'editable' => self::editable($key),
            'enabled' => in_array($key, SmsTemplates::EVENTS, true) ? (bool) ($toggles[$key] ?? false) : null,
            'merge_fields' => self::MERGE_FIELDS[$key],
            'required_fields' => self::REQUIRED_FIELDS[$key] ?? [],
            'preview' => self::preview($store, $key, $language, $body),
            'updated_at' => $row?->updated_at?->toIso8601ZuluString(),
            'updated_by' => $row?->updatedBy !== null ? ['id' => $row->updatedBy->id, 'name' => (string) $row->updatedBy->name] : null,
            'revision' => $row?->revision ?? 0,
        ];
    }
}
