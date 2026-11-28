<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use InvalidArgumentException;

/**
 * PHASE-8-9D P89D-17 (S334), generalised from PHASE-8-9B S224 (`SmsEndpointGuard` delegates here): the only merchant /
 * staff entered URLs we call. On save: https, no userinfo, a host name (never an IP literal), no local names. On send:
 * every resolved address must be public (private, loopback, link-local, CGNAT 100.64/10, metadata and reserved ranges
 * refused) and the request is pinned to the checked address (CURLOPT_RESOLVE), so a DNS rebind between the check and
 * the call can't reach an internal host. Integrations require port 443; callers add no redirects and short timeouts.
 */
class PublicEndpointGuard
{
    public function __construct(private readonly PublicHostResolver $resolver) {}

    /** @throws InvalidArgumentException */
    public static function assertAcceptable(string $url, bool $only443 = true): void
    {
        SafeHttpClient::assertSafeBaseUrl($url);
        $host = strtolower(trim((string) parse_url($url, PHP_URL_HOST), '[]'));
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            throw new InvalidArgumentException('Use a host name, not an IP address.');
        }
        if ($host === 'localhost' || ! str_contains($host, '.') || preg_match('/\.(local|localhost|internal|lan|home|corp|intranet)$/', $host) === 1) {
            throw new InvalidArgumentException('Integration base URLs must not point at local hosts.');
        }
        $port = parse_url($url, PHP_URL_PORT);
        if ($only443 && $port !== null && $port !== false && (int) $port !== 443) {
            throw new InvalidArgumentException('Only the standard https port (443) is allowed.');
        }
    }

    public static function isPublicIp(string $ip): bool
    {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return false;
        }
        $long = ip2long($ip);
        if ($long !== false) {
            foreach ([['100.64.0.0', 10], ['169.254.0.0', 16], ['0.0.0.0', 8], ['192.0.0.0', 24], ['198.18.0.0', 15]] as [$net, $bits]) {
                $mask = -1 << (32 - $bits);
                if (($long & $mask) === (ip2long($net) & $mask)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Resolves and checks the host; returns the curl `CURLOPT_RESOLVE` pin entries for the request.
     *
     * @return list<string>
     *
     * @throws InvalidArgumentException
     */
    public function pin(string $url, bool $only443 = true): array
    {
        self::assertAcceptable($url, $only443);
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $port = (int) (parse_url($url, PHP_URL_PORT) ?: 443);
        $ips = $this->resolver->resolve($host);
        if ($ips === []) {
            throw new InvalidArgumentException('The host does not resolve.');
        }
        foreach ($ips as $ip) {
            if (! self::isPublicIp($ip)) {
                throw new InvalidArgumentException('The host resolves to a private or reserved address.');
            }
        }

        return ["{$host}:{$port}:{$ips[0]}"];
    }
}
