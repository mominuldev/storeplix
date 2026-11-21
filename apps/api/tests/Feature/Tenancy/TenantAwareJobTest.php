<?php

namespace Tests\Feature\Tenancy;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Fixtures\RecordTenantJob;
use Tests\TestCase;

#[Group('tenancy')]
#[Group('tenancy')]
class TenantAwareJobTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        RecordTenantJob::$runs = [];
    }

    public function test_queued_job_restores_the_dispatching_tenant_in_a_worker(): void
    {
        config(['queue.default' => 'database']);

        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantA, 'alpha');
        $this->storeFor($tenantB, 'bravo');

        $this->tenancy()->run($tenantA, function () {
            RecordTenantJob::dispatch(); // PendingDispatch dispatches on destruct: keep it a statement
        });
        $this->tenancy()->run($tenantB, function () {
            RecordTenantJob::dispatch(); // PendingDispatch dispatches on destruct: keep it a statement
        });

        $payloadTenants = DB::table('jobs')->orderBy('id')->pluck('payload')
            ->map(fn ($p) => json_decode($p, true))
            ->filter(fn ($p) => $p['displayName'] === RecordTenantJob::class)
            ->map(fn ($p) => $p['tenant_id'] ?? null)->values()->all();
        $this->assertSame([$tenantA->id, $tenantB->id], $payloadTenants);

        $this->assertFalse($this->tenancy()->has());
        $this->artisan('queue:work', ['--stop-when-empty' => true, '--tries' => 1])->assertExitCode(0);

        $this->assertSame([
            ['tenant' => $tenantA->id, 'slugs' => ['alpha']],
            ['tenant' => $tenantB->id, 'slugs' => ['bravo']],
        ], RecordTenantJob::$runs);
        $this->assertSame(0, DB::table('failed_jobs')->count());
    }

    public function test_sync_job_runs_in_tenant_and_restores_callers_context(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantA, 'alpha');
        $this->storeFor($tenantB, 'bravo');

        $after = $this->tenancy()->run($tenantA, function () {
            RecordTenantJob::dispatchSync();

            return $this->tenancy()->id();
        });

        $this->assertSame([['tenant' => $tenantA->id, 'slugs' => ['alpha']]], RecordTenantJob::$runs);
        $this->assertSame($tenantA->id, $after);
    }

    public function test_explicit_tenant_pin_wins_and_job_without_tenant_fails(): void
    {
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantB, 'bravo');

        dispatch_sync((new RecordTenantJob)->forTenant($tenantB->id));
        $this->assertSame([['tenant' => $tenantB->id, 'slugs' => ['bravo']]], RecordTenantJob::$runs);
        $this->assertFalse($this->tenancy()->has());

        $this->expectException(MissingTenantContextException::class);
        dispatch_sync(new RecordTenantJob);
    }
}
