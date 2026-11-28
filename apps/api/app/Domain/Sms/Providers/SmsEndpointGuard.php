<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Integrations\SafeHttpClient;
use InvalidArgumentException;

/**
 * PHASE-8-9B S224: staff-entered provider endpoints. On save: SafeHttpClient's rules (https, no userinfo) plus no IP
 * literal at all and no local names. At send: every resolved address must be public (private, loopback, link-local,
 * CGNAT 100.64/10, metadata and reserved ranges refused) and the request is pinned to the checked address
 * (CURLOPT_RESOLVE), so a DNS rebind between the check and the call can't reach an internal host.
 */
final class SmsEndpointGuard
{
    public function __construct(private readonly SmsHostResolver $resolver) {}

    /** @throws InvalidArgumentException */
    public static function assertAcceptable(string $url): void
    {
        SafeHttpClient::assertSafeBaseUrl($url);
        $host = strtolower(trim((string) parse_url($url, PHP_URL_HOST), '[]'));
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            throw new InvalidArgumentException('Use a host name, not an IP address.');
        }
        if ($host === 'localhost' || ! str_contains($host, '.') || preg_match('/\.(local|localhost|internal|lan|home|corp|intranet)$/', $host) === 1) {
            throw new InvalidArgumentException('Integration base URLs must not point at local hosts.');
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
    public function pin(string $url): array
    {
        self::assertAcceptable($url);
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $port = (int) (parse_url($url, PHP_URL_PORT) ?: 443);
        $ips = $this->resolver->resolve($host);
        if ($ips === []) {
            throw new InvalidArgumentException('The provider host does not resolve.');
        }
        foreach ($ips as $ip) {
            if (! self::isPublicIp($ip)) {
                throw new InvalidArgumentException('The provider host resolves to a private or reserved address.');
            }
        }

        return ["{$host}:{$port}:{$ips[0]}"];
    }
}
