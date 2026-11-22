<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Services\HostNormalizer;

/**
 * P6-4 / P6-5: the one place a merchant-typed hostname becomes the canonical stored form (lowercase ASCII/punycode,
 * no trailing dot). Rejects with 422 `domain_invalid` (not a usable public hostname) or `domain_reserved`.
 */
final class HostnameInput
{
    /** Special-use / private TLDs that never resolve publicly (P6-5). */
    public const SPECIAL_USE_TLDS = [
        'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'example',
        'invalid', 'onion', 'arpa', 'alt',
    ];

    private const IDNA_TO_ASCII = IDNA_NONTRANSITIONAL_TO_ASCII | IDNA_CHECK_BIDI | IDNA_CHECK_CONTEXTJ;

    private const IDNA_TO_UNICODE = IDNA_NONTRANSITIONAL_TO_UNICODE | IDNA_CHECK_BIDI | IDNA_CHECK_CONTEXTJ;

    /** @throws ApiException 422 domain_invalid | domain_reserved */
    public static function normalize(string $raw): NormalizedHostname
    {
        $host = trim($raw);
        if ($host === '' || preg_match('#[/:@*\s\\\\?\#%]#u', $host) === 1) {
            throw self::invalid('Enter a hostname without https://, a path or a port, like shop.example.com.');
        }
        $host = mb_strtolower($host, 'UTF-8');
        if (str_ends_with($host, '.')) {
            $host = substr($host, 0, -1);
        }
        if ($host === '' || str_contains($host, '..')) {
            throw self::invalid();
        }

        $info = [];
        $ascii = idn_to_ascii($host, self::IDNA_TO_ASCII, INTL_IDNA_VARIANT_UTS46, $info);
        if (! is_string($ascii) || ($info['errors'] ?? 1) !== 0) {
            throw self::invalid('This domain name contains characters that are not allowed.');
        }
        $ascii = strtolower($ascii);
        $unicode = idn_to_utf8($ascii, self::IDNA_TO_UNICODE, INTL_IDNA_VARIANT_UTS46, $info);
        if (! is_string($unicode) || ($info['errors'] ?? 1) !== 0) {
            throw self::invalid('This domain name contains characters that are not allowed.');
        }

        // The existing label rules (a-z0-9, inner hyphens, 1..63 per label).
        if (HostNormalizer::normalize($ascii) !== $ascii || strlen($ascii) > 253) {
            throw self::invalid();
        }
        $labels = explode('.', $ascii);
        $tld = (string) end($labels);
        if (count($labels) < 2 || ctype_digit($tld) || filter_var($ascii, FILTER_VALIDATE_IP) !== false) {
            throw self::invalid('Enter a full domain name like shop.example.com.');
        }

        if (self::isReserved($ascii)) {
            throw new ApiException(422, 'domain_reserved', 'This domain belongs to Store Plix and can’t be connected.', ['hostname' => ['This domain is reserved.']]);
        }

        // P6-5 exception: fake mode (never production) accepts *.localhost so e2e can browse a custom host.
        if ($tld === 'localhost' && self::fakeLocalhostAllowed()) {
            return new NormalizedHostname($ascii, $unicode, $ascii);
        }
        if (in_array($tld, self::SPECIAL_USE_TLDS, true)) {
            throw self::invalid('This domain can’t be reached from the internet.');
        }

        $registrable = PublicSuffixes::registrable($ascii);
        if ($registrable === null) {
            throw self::invalid('Enter a domain you own, like shop.example.com, not a domain ending such as com.bd.');
        }

        return new NormalizedHostname($ascii, $unicode, $registrable);
    }

    /** Registrable domain for display purposes (name_relative); never throws. */
    public static function registrableFor(string $asciiHost): string
    {
        if (str_ends_with($asciiHost, '.localhost')) {
            return $asciiHost;
        }

        return PublicSuffixes::registrable($asciiHost) ?? $asciiHost;
    }

    public static function display(string $asciiHost): string
    {
        $info = [];
        $unicode = idn_to_utf8($asciiHost, self::IDNA_TO_UNICODE, INTL_IDNA_VARIANT_UTS46, $info);

        return is_string($unicode) && ($info['errors'] ?? 1) === 0 ? $unicode : $asciiHost;
    }

    public static function isReserved(string $asciiHost): bool
    {
        $suffixes = array_filter(array_map(
            fn ($s) => strtolower(rtrim(trim((string) $s), '.')),
            [...(array) config('domains.reserved_suffixes', []), 'storeplix.com', (string) config('storeplix.platform_domain'), (string) config('domains.cname_target')],
        ));
        foreach ($suffixes as $suffix) {
            if ($asciiHost === $suffix || str_ends_with($asciiHost, '.'.$suffix)) {
                return true;
            }
        }

        return false;
    }

    public static function fakeLocalhostAllowed(): bool
    {
        return (bool) config('domains.fake') && ! app()->environment('production');
    }

    private static function invalid(string $message = 'This is not a valid domain name.'): ApiException
    {
        return new ApiException(422, 'domain_invalid', $message, ['hostname' => [$message]]);
    }
}
