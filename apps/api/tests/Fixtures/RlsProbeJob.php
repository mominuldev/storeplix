<?php

namespace Tests\Fixtures;

use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;

/** RLS lifecycle probe (PHASE-5B-CONTRACT §2.6): what the DATABASE session sees inside a worker job. */
class RlsProbeJob implements ShouldQueue
{
    use Queueable, TenantAware;

    /** @var list<array{context: string|null, guc: string, orders: list<string>}> */
    public static array $runs = [];

    public function handle(TenantContext $context): void
    {
        static::$runs[] = [
            'context' => $context->id(),
            'guc' => (string) DB::selectOne("select current_setting('app.tenant_id', true) as t")->t,
            // raw SQL, no app-level scope: only RLS filters this
            'orders' => DB::table('orders')->orderBy('tenant_id')->pluck('tenant_id')->unique()->values()->all(),
        ];
    }
}
