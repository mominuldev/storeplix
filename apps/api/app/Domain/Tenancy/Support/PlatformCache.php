<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

/**
 * Platform-wide cache keys (PHASE-8-9B §4.3/P89B-8): never tenant data, so not tenant-prefixed, but always namespaced
 * under `platform:` so they can't collide with TenantCache keys (`tenant:{id}:…`).
 */
final class PlatformCache
{
    public static function key(string $suffix): string
    {
        return 'platform:'.$suffix;
    }
}
