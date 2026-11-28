<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

/** DNS lookup for provider endpoints (S224 pin). Bound in the container so tests can answer without the network. */
class SmsHostResolver
{
    /** @return list<string> IPv4 addresses (empty when the name does not resolve) */
    public function resolve(string $host): array
    {
        $ips = @gethostbynamel($host);

        return is_array($ips) ? array_values($ips) : [];
    }
}
