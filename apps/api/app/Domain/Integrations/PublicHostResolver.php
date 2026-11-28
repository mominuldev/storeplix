<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

/** DNS lookup for merchant-given endpoints (P89D-17 pin). Bound in the container so tests answer without the network. */
class PublicHostResolver
{
    /** @return list<string> IPv4 addresses (empty when the name does not resolve) */
    public function resolve(string $host): array
    {
        $ips = @gethostbynamel($host);

        return is_array($ips) ? array_values($ips) : [];
    }
}
