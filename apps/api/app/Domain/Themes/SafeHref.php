<?php

namespace App\Domain\Themes;

/**
 * Server-side link allowlists (PHASE-3-CONTRACT §8). Everything not explicitly allowed is rejected:
 * javascript:, data:, vbscript:, protocol-relative (//, /\), credentials, control chars, whitespace and
 * percent-encoded variants of all of those.
 */
final class SafeHref
{
    public const MAX_LENGTH = 2048;

    /** Theme hrefs: relative "/…" or https:// with a host and no credentials. */
    public static function theme(mixed $value): bool
    {
        if (! self::basic($value)) {
            return false;
        }

        return self::relative($value) || self::absolute($value, ['https']);
    }

    /** Navigation "url" links: http or https only, with a host, no credentials. */
    public static function navUrl(mixed $value): bool
    {
        return self::basic($value) && self::absolute($value, ['http', 'https']);
    }

    /** Rich-text link marks: theme rules + http:// + strict mailto: and tel:. */
    public static function richText(mixed $value): bool
    {
        if (! self::basic($value)) {
            return false;
        }

        return self::relative($value)
            || self::absolute($value, ['https', 'http'])
            || self::mailto($value)
            || self::tel($value);
    }

    /** Page "button" blocks: theme rules, https://wa.me/<digits>, or tel:. */
    public static function button(mixed $value): bool
    {
        if (! self::basic($value)) {
            return false;
        }

        return self::theme($value) || self::tel($value)
            || preg_match('#^https://wa\.me/[0-9]{6,15}$#', $value) === 1;
    }

    public static function mailto(string $value): bool
    {
        return preg_match('/^mailto:[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+$/', $value) === 1
            && ! str_contains($value, '%');
    }

    public static function tel(string $value): bool
    {
        return preg_match('/^tel:\+?[0-9]{7,15}$/', $value) === 1;
    }

    /** Length, no control characters / whitespace / backslashes, also after percent-decoding. */
    private static function basic(mixed $value): bool
    {
        if (! is_string($value) || $value === '' || strlen($value) > self::MAX_LENGTH || ! mb_check_encoding($value, 'UTF-8')) {
            return false;
        }

        foreach (self::decodings($value) as $candidate) {
            // Control chars (C0, DEL, C1), any Unicode whitespace / invisible separators, backslash.
            if (preg_match('/[\x00-\x20\x7F\\\\]|[\x{0080}-\x{00A0}\x{1680}\x{180E}\x{2000}-\x{200F}\x{2028}-\x{202F}\x{205F}-\x{2064}\x{3000}\x{FEFF}]/u', $candidate) === 1) {
                return false;
            }
        }

        return true;
    }

    /** "/path" — never "//host" or "/\host", also after decoding. */
    private static function relative(string $value): bool
    {
        foreach (self::decodings($value) as $candidate) {
            if (! str_starts_with($candidate, '/') || str_starts_with($candidate, '//')) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param  list<string>  $schemes  lowercase allowed schemes
     */
    private static function absolute(string $value, array $schemes): bool
    {
        if (preg_match('#^([a-z][a-z0-9+.\-]*)://#i', $value, $m) !== 1 || ! in_array(strtolower($m[1]), $schemes, true)) {
            return false;
        }

        $parts = parse_url($value);
        if ($parts === false || ! isset($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            return false;
        }

        // "@" anywhere before the path is userinfo in some parsers → reject.
        $authority = substr($value, strlen($m[0]));
        $authority = strtok($authority, '/?#') ?: '';
        if (str_contains($authority, '@') || str_contains(rawurldecode($authority), '@')) {
            return false;
        }

        $host = strtolower($parts['host']);

        return preg_match('/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?$/', $host) === 1
            || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) !== false;
    }

    /**
     * The value and its successive percent-decodings (catches %6a%61vascript:, %2F%2Fevil.com, double encoding).
     *
     * @return list<string>
     */
    private static function decodings(string $value): array
    {
        $out = [$value];
        for ($i = 0; $i < 3; $i++) {
            $decoded = rawurldecode($value);
            if ($decoded === $value) {
                break;
            }
            $out[] = $value = $decoded;
        }

        return $out;
    }
}
