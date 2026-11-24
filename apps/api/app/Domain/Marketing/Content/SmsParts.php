<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Content;

/**
 * SMS part counting (PHASE-8-5 §5.3, P85-18). Server count is authoritative; the dashboard mirrors it (`smsParts()`)
 * and both run docs/api/sms-parts-vectors.json.
 *
 * GSM-7 when every character is in the GSM 03.38 basic set or the extension table (`^{}\[~]|€` count 2 septets;
 * form feed is not included, §9.1); one part ≤ 160 septets, else 153 per part. Otherwise UCS-2: one part ≤ 70 UTF-16 code units, else 67
 * per part (an emoji outside the BMP is 2 units).
 */
final class SmsParts
{
    public const GSM7 = 'gsm7';

    public const UCS2 = 'ucs2';

    /** GSM 03.38 basic character set (ESC excluded). */
    private const BASIC = "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

    /** GSM 03.38 extension table (2 septets each). */
    private const EXTENSION = '^{}\\[~]|€';

    /** @var array<string, int>|null char → septets */
    private static ?array $gsm = null;

    /** @return array{encoding: 'gsm7'|'ucs2', parts: int, units: int} */
    public static function count(string $text): array
    {
        $septets = self::septets($text);
        if ($septets !== null) {
            return ['encoding' => self::GSM7, 'parts' => self::parts($septets, 160, 153), 'units' => $septets];
        }
        $units = intdiv(strlen((string) mb_convert_encoding($text, 'UTF-16BE', 'UTF-8')), 2);

        return ['encoding' => self::UCS2, 'parts' => self::parts($units, 70, 67), 'units' => $units];
    }

    public static function partsOf(string $text): int
    {
        return self::count($text)['parts'];
    }

    /** Septet length when the text is all GSM-7, else null. */
    private static function septets(string $text): ?int
    {
        if (self::$gsm === null) {
            self::$gsm = [];
            foreach (mb_str_split(self::BASIC) as $c) {
                self::$gsm[$c] = 1;
            }
            foreach (mb_str_split(self::EXTENSION) as $c) {
                self::$gsm[$c] = 2;
            }
        }
        $total = 0;
        foreach (mb_str_split($text) as $c) {
            $n = self::$gsm[$c] ?? null;
            if ($n === null) {
                return null;
            }
            $total += $n;
        }

        return $total;
    }

    private static function parts(int $units, int $single, int $multi): int
    {
        if ($units === 0) {
            return 0;
        }

        return $units <= $single ? 1 : (int) ceil($units / $multi);
    }
}
