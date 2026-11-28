<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Integrations\PublicEndpointGuard;
use InvalidArgumentException;

/**
 * PHASE-8-9B S224: staff-entered provider endpoints. Since PHASE-8-9D (P89D-17) the rules live in
 * App\Domain\Integrations\PublicEndpointGuard; this class delegates (any port, as before 8.9d) with the SMS resolver.
 */
final class SmsEndpointGuard
{
    public function __construct(private readonly SmsHostResolver $resolver) {}

    /** @throws InvalidArgumentException */
    public static function assertAcceptable(string $url): void
    {
        PublicEndpointGuard::assertAcceptable($url, only443: false);
    }

    public static function isPublicIp(string $ip): bool
    {
        return PublicEndpointGuard::isPublicIp($ip);
    }

    /**
     * @return list<string>
     *
     * @throws InvalidArgumentException
     */
    public function pin(string $url): array
    {
        try {
            return (new PublicEndpointGuard($this->resolver))->pin($url, only443: false);
        } catch (InvalidArgumentException $e) {
            throw new InvalidArgumentException(str_replace('The host', 'The provider host', $e->getMessage()), 0, $e);
        }
    }
}
