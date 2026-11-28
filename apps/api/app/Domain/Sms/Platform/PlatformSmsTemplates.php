<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Identity\Models\User;
use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\PlatformSmsMessageTypeSetting;
use App\Domain\Sms\Models\PlatformSmsTemplate;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-9B §6 (P89B-12 – P89B-15, S227): defaults (resources/sms/platform/{bn,en}.php), custom bodies, the editor rules
 * shared by PUT, preview and broadcasts (1–480 chars, only the type's merge fields, required ones kept, no typed links,
 * sample render ≤ 3 parts), sample values and the renderer (every var sanitised; `{link}` inserted last).
 */
final class PlatformSmsTemplates
{
    public const MAX_LENGTH = 480;

    public const LANGUAGES = ['bn', 'en'];

    /** Length caps of the free-text vars after S13 cleaning. */
    private const VAR_MAX = ['merchant_name' => 40, 'store_name' => 40, 'plan' => 30, 'invoice_no' => 32, 'amount' => 20, 'due_date' => 20, 'otp' => 8];

    public static function defaultBody(PlatformSmsType $type, string $language): string
    {
        $all = require resource_path('sms/platform/'.($language === 'en' ? 'en' : 'bn').'.php');

        return (string) ($all[$type->value] ?? '');
    }

    public static function custom(PlatformSmsType $type, string $language): ?PlatformSmsTemplate
    {
        return $type->editable()
            ? PlatformSmsTemplate::query()->where('type', $type->value)->where('language', $language)->first()
            : null;
    }

    /** The effective body: the custom one, else the default. */
    public static function body(PlatformSmsType $type, string $language): string
    {
        return self::custom($type, $language)?->body ?? self::defaultBody($type, $language);
    }

    /** P89B-15: locked types are always on; the others follow their switch (default on). */
    public static function enabled(PlatformSmsType $type): bool
    {
        if ($type->locked()) {
            return true;
        }
        $value = PlatformSmsMessageTypeSetting::query()->whereKey($type->value)->value('enabled');

        return $value === null ? true : (bool) $value;
    }

    public static function normalise(string $body): string
    {
        return trim((string) preg_replace('/[\r\n]+/u', ' ', $body));
    }

    /** 422 `platform_sms_type_locked` for locked types and broadcasts (their text is not a template). */
    public static function assertEditable(PlatformSmsType $type): void
    {
        if (! $type->editable()) {
            throw new ApiException(422, 'platform_sms_type_locked', $type->locked()
                ? 'Account code texts are fixed and can’t be edited.'
                : 'Broadcast texts are written per broadcast.');
        }
    }

    /**
     * S227 body rules. `$field` names the input in validation errors.
     *
     * @return array{body: string, preview: array{text: string, parts: int, encoding: string, characters: int}}
     */
    public static function validate(PlatformSmsType $type, string $language, string $body, string $field = 'body'): array
    {
        $body = self::normalise($body);
        $length = mb_strlen($body);
        if ($length < 1 || $length > self::MAX_LENGTH) {
            throw ValidationException::withMessages([$field => [$length < 1 ? 'Write a message.' : 'The message may not be longer than 480 characters.']]);
        }
        if (preg_match('~https?://|www\.~iu', $body) === 1) {
            throw new ApiException(422, 'platform_sms_template_link_not_allowed', 'Links can’t be typed into an SMS. Use {link} instead.');
        }
        preg_match_all('/\{([^{}]*)\}/u', $body, $m);
        $used = array_values(array_unique($m[1]));
        $unknown = array_values(array_diff($used, $type->locked() ? $type->mergeFields() : array_diff($type->mergeFields(), ['otp'])));
        if ($unknown !== []) {
            throw new ApiException(422, 'platform_sms_template_unknown_merge_field', 'This message uses merge fields that don’t exist for it: {'.implode('}, {', $unknown).'}.', ['fields' => $unknown]);
        }
        $missing = array_values(array_diff($type->requiredFields(), $used));
        if ($missing !== []) {
            throw new ApiException(422, 'platform_sms_template_missing_merge_field', 'This message must keep {'.implode('}, {', $missing).'}.', ['fields' => $missing]);
        }
        $preview = self::preview($type, $language, $body);
        $max = (int) config('sms.template_max_parts', 3);
        if ($preview['parts'] > $max) {
            throw new ApiException(422, 'platform_sms_template_too_long', "Too long for one message. Keep it within {$max} parts.", ['parts' => $preview['parts'], 'max_parts' => $max]);
        }

        return ['body' => $body, 'preview' => $preview];
    }

    /** @return array{text: string, parts: int, encoding: string, characters: int} */
    public static function preview(PlatformSmsType $type, string $language, string $body): array
    {
        return self::count(self::render($body, self::sampleVars($language)));
    }

    /** @return array{text: string, parts: int, encoding: string, characters: int} */
    public static function count(string $text): array
    {
        $c = SmsParts::count($text);

        return ['text' => $text, 'parts' => $c['parts'], 'encoding' => $c['encoding'], 'characters' => $c['units']];
    }

    /** §6.3 sample values. @return array<string, string> */
    public static function sampleVars(string $language): array
    {
        return [
            'merchant_name' => $language === 'bn' ? 'নাসরিন' : 'Nasrin',
            'store_name' => 'Mugdho Fashion',
            'invoice_no' => 'SP-2026-001042',
            'amount' => '1,770',
            'due_date' => '5 Dec 2026',
            'plan' => 'Growth',
            'link' => self::planLink(),
            'otp' => '482913',
        ];
    }

    public static function planLink(): string
    {
        return rtrim((string) config('storeplix.merchant_app_url'), '/').'/settings/plan';
    }

    /**
     * Fills a body: every var cleaned (S13: control characters and URLs removed, braces dropped, length-capped), then
     * `{link}` (server-made) last.
     *
     * @param  array<string, string|int|null>  $vars
     */
    public static function render(string $body, array $vars): string
    {
        $replace = [];
        foreach ($vars as $key => $value) {
            if ($key === 'link') {
                continue;
            }
            $clean = str_replace(['{', '}'], '', SmsTemplates::clean((string) $value, self::VAR_MAX[$key] ?? 40));
            $replace['{'.$key.'}'] = $clean;
        }
        $text = strtr(self::normalise($body), $replace);
        $link = (string) ($vars['link'] ?? '');
        $text = str_replace('{link}', $link, $text);

        return trim((string) preg_replace('/\s+/u', ' ', $text));
    }

    /** @return array{id: string, name: string}|null */
    public static function userRef(?string $id): ?array
    {
        $u = $id !== null ? User::query()->find($id, ['id', 'name']) : null;

        return $u !== null ? ['id' => $u->id, 'name' => (string) $u->name] : null;
    }

    /**
     * PlatformSmsTemplate (openapi 1.24.0).
     *
     * @return array<string, mixed>
     */
    public static function present(PlatformSmsType $type, string $language, ?PlatformSmsTemplate $row = null, bool $lookup = true): array
    {
        $row ??= $lookup ? self::custom($type, $language) : null;
        $default = self::defaultBody($type, $language);
        $body = $row?->body ?? $default;
        $preview = self::preview($type, $language, $body);

        return [
            'language' => $language,
            'body' => $body,
            'default_body' => $default,
            'is_custom' => $row !== null,
            'preview' => $preview['text'],
            'parts' => $preview['parts'],
            'revision' => $row?->revision ?? 0,
            'updated_at' => $row?->updated_at?->toIso8601ZuluString(),
            'updated_by' => self::userRef($row?->updated_by),
        ];
    }
}
