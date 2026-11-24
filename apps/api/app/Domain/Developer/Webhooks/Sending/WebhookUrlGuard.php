<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/**
 * SSRF rules for merchant webhook URLs (PHASE-8-4 §4.3, S107, SECURITY T14): https only (http only with
 * WEBHOOKS_OUT_ALLOW_HTTP, never in production); no credentials; port 443 or 1024–65535 minus the configured internal
 * ports; the host must not be local, and every address it resolves to must be public (no private, loopback,
 * link-local, CGNAT, metadata, multicast, reserved or IPv6 ULA ranges). Checked on save and again before each send;
 * the sender pins the connection to the checked IP. With WEBHOOKS_OUT_FAKE no DNS lookup happens (nothing connects).
 */
final class WebhookUrlGuard
{
    /** CIDR blocks never reachable from the sender (on top of PHP's private/reserved filters). */
    private const BLOCKED = [
        '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
        '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
        '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
        '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10',
        'fec0::/10', 'ff00::/8',
    ];

    private const LOCAL_HOSTS = ['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default'];

    private const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.svc', '.cluster.local'];

    public function __construct(private readonly HostResolver $resolver) {}

    /** @throws UrlNotAllowed */
    public function check(string $url, ?bool $resolve = null): WebhookTarget
    {
        $resolve ??= ! (bool) config('webhooks_out.fake');
        $parts = parse_url($url);
        if (! is_array($parts) || ! isset($parts['scheme'], $parts['host']) || $parts['host'] === '') {
            throw new UrlNotAllowed('Enter a full URL starting with https://.');
        }
        $scheme = strtolower($parts['scheme']);
        $http = $scheme === 'http' && self::httpAllowed();
        if ($scheme !== 'https' && ! $http) {
            throw new UrlNotAllowed('Webhook URLs must use https://.');
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            throw new UrlNotAllowed('Webhook URLs can’t contain a username or password.');
        }
        $port = (int) ($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
        if (! self::portAllowed($port, $http)) {
            throw new UrlNotAllowed('Use port 443 or a port from 1024 to 65535.');
        }

        $host = rtrim(strtolower($parts['host']), '.');
        $literal = trim($host, '[]');
        if (filter_var($literal, FILTER_VALIDATE_IP) !== false) {
            if (! self::isPublicIp($literal)) {
                throw new UrlNotAllowed('Webhook URLs must point at a public address.');
            }

            return new WebhookTarget($url, $scheme, $literal, $port, [$literal]);
        }
        if (! preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/', $host) || self::isLocalName($host)
            || preg_match('/^[0-9.]+$/', $host) || preg_match('/^0x/i', $host)) {
            throw new UrlNotAllowed('Webhook URLs must use a public host name.');
        }
        if (! $resolve) {
            return new WebhookTarget($url, $scheme, $host, $port, []);
        }

        $ips = $this->resolver->resolve($host);
        if ($ips === []) {
            throw new UrlNotAllowed('This host name doesn’t resolve.');
        }
        foreach ($ips as $ip) {
            if (! self::isPublicIp($ip)) {
                throw new UrlNotAllowed('Webhook URLs must point at a public address.');
            }
        }

        return new WebhookTarget($url, $scheme, $host, $port, array_values($ips));
    }

    public static function httpAllowed(): bool
    {
        return (bool) config('webhooks_out.allow_http') && ! app()->environment('production');
    }

    public static function portAllowed(int $port, bool $http = false): bool
    {
        if ($port === 443 || ($http && $port === 80)) {
            return true;
        }

        return $port >= 1024 && $port <= 65535 && ! in_array($port, (array) config('webhooks_out.blocked_ports', []), true);
    }

    public static function isLocalName(string $host): bool
    {
        if (in_array($host, self::LOCAL_HOSTS, true)) {
            return true;
        }
        foreach (self::LOCAL_SUFFIXES as $suffix) {
            if (str_ends_with($host, $suffix)) {
                return true;
            }
        }

        return false;
    }

    public static function isPublicIp(string $ip): bool
    {
        if (filter_var($ip, FILTER_VALIDATE_IP) === false
            || filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return false;
        }
        $packed = inet_pton($ip);
        if ($packed === false) {
            return false;
        }
        foreach (self::BLOCKED as $cidr) {
            if (self::inCidr($packed, $cidr)) {
                return false;
            }
        }

        return true;
    }

    private static function inCidr(string $packed, string $cidr): bool
    {
        [$network, $bits] = explode('/', $cidr);
        $net = inet_pton($network);
        if ($net === false || strlen($net) !== strlen($packed)) {
            return false;
        }
        $bits = (int) $bits;
        $bytes = intdiv($bits, 8);
        if (strncmp($packed, $net, $bytes) !== 0) {
            return false;
        }
        $rest = $bits % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;

        return (ord($packed[$bytes]) & $mask) === (ord($net[$bytes]) & $mask);
    }
}
