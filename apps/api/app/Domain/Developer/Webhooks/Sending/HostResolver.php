<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/** DNS lookup for outbound webhook hosts (A + AAAA). Tests bind a fake. */
interface HostResolver
{
    /** @return list<string> IP addresses; empty when the name doesn't resolve */
    public function resolve(string $host): array;
}
