<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Developer\Webhooks\Sending\HostResolver;

/** Test DNS: host → IPs (unknown hosts don't resolve). */
final class FakeHostResolver implements HostResolver
{
    /** @param array<string, list<string>> $map */
    public function __construct(public array $map = []) {}

    public function resolve(string $host): array
    {
        return $this->map[$host] ?? [];
    }
}
