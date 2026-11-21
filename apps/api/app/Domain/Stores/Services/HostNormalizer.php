<?php

namespace App\Domain\Stores\Services;

/**
 * Normalizes a hostname for lookup: trims, lowercases, strips port and trailing dot.
 * Returns null for anything that is not a plausible DNS hostname.
 */
final class HostNormalizer
{
    public static function normalize(?string $host): ?string
    {
        if ($host === null) {
            return null;
        }

        $host = strtolower(trim($host));

        // Strip :port (no IPv6 literals: storefronts are always served on hostnames).
        if (str_contains($host, ':')) {
            if (substr_count($host, ':') > 1) {
                return null;
            }
            [$host, $port] = explode(':', $host, 2);
            if ($port !== '' && ! ctype_digit($port)) {
                return null;
            }
        }

        $host = rtrim($host, '.');

        if ($host === '' || strlen($host) > 253) {
            return null;
        }

        // Labels: a-z0-9 and inner hyphens, 1..63 chars each.
        if (! preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/', $host)) {
            return null;
        }

        return $host;
    }
}
