<?php

namespace Tests\Fixtures;

use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class RecordTenantJob implements ShouldQueue
{
    use Queueable, TenantAware;

    /** @var array<int, array{tenant: string|null, slugs: list<string>}> */
    public static array $runs = [];

    public function handle(TenantContext $context): void
    {
        static::$runs[] = [
            'tenant' => $context->id(),
            'slugs' => Store::query()->orderBy('slug')->pluck('slug')->all(),
        ];
    }
}
