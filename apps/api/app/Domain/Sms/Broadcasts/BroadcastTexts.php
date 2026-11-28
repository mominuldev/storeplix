<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Sms\Platform\PlatformSmsTemplates;
use App\Domain\Sms\Platform\PlatformSmsType;

/** PHASE-8-9B §7.5 / P89B-21: the broadcast text = rendered body + " " + the per-recipient STOP footer. */
final class BroadcastTexts
{
    public const FOOTER = ['bn' => 'বন্ধ করতে: {url}', 'en' => 'STOP: {url}'];

    public const SAMPLE_CODE = 'Ab3dE6gH9k';

    public const TEST_CODE = 'test';

    public static function optOutUrl(string $code): string
    {
        $base = (string) (config('sms.platform.opt_out_base') ?: rtrim((string) config('storeplix.merchant_app_url'), '/').'/s');

        return rtrim($base, '/').'/'.$code;
    }

    /** @param array<string, string|int|null> $vars */
    public static function text(string $body, string $language, array $vars, string $code): string
    {
        $rendered = PlatformSmsTemplates::render($body, $vars + ['link' => PlatformSmsTemplates::planLink()]);

        return $rendered.' '.str_replace('{url}', self::optOutUrl($code), self::FOOTER[$language === 'en' ? 'en' : 'bn']);
    }

    /** Body rules (§6.3 with the broadcast merge fields). @return string the normalised body */
    public static function validate(string $body, string $language, string $field): string
    {
        return PlatformSmsTemplates::validate(PlatformSmsType::Broadcast, $language, $body, $field)['body'];
    }

    /** Parts of the sample text incl. the footer. */
    public static function sampleParts(string $body, string $language): int
    {
        return PlatformSmsTemplates::count(self::text($body, $language, PlatformSmsTemplates::sampleVars($language), self::SAMPLE_CODE))['parts'];
    }

    /** 10 base62 characters (P89B-21). */
    public static function newCode(): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $code = '';
        for ($i = 0; $i < 10; $i++) {
            $code .= $alphabet[random_int(0, 61)];
        }

        return $code;
    }
}
