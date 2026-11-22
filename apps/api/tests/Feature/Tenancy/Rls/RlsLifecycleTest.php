<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Exceptions\TenantSwitchInTransaction;
use App\Domain\Tenancy\Middleware\ResetDatabaseTenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Fixtures\RlsProbeJob;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S21 (PHASE-5B-CONTRACT §2.5, §2.6): app.tenant_id / app.user_id never leak across jobs or requests.
 */
#[Group('rls')]
#[Group('tenancy')]
class RlsLifecycleTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
        RlsProbeJob::$runs = [];
    }

    public function test_worker_running_job_a_then_job_b_never_sees_a_in_b(): void
    {
        $t = $this->twoTenantsWithOrders();
        config(['queue.default' => 'database']);

        $this->inTenant($t['a']['tenant'], function () {
            RlsProbeJob::dispatch(); // PendingDispatch dispatches on destruct: keep it a statement
        });
        $this->inTenant($t['b']['tenant'], function () {
            RlsProbeJob::dispatch();
        });

        $this->setGuc($t['a']['tenant']->id, $t['a']['user']->id); // a stale session state the worker must not keep
        $this->artisan('queue:work', ['--stop-when-empty' => true, '--tries' => 1])->assertExitCode(0);

        $this->assertSame([
            ['context' => $t['a']['tenant']->id, 'guc' => $t['a']['tenant']->id, 'orders' => [$t['a']['tenant']->id]],
            ['context' => $t['b']['tenant']->id, 'guc' => $t['b']['tenant']->id, 'orders' => [$t['b']['tenant']->id]],
        ], array_map(fn ($r) => ['context' => $r['context'], 'guc' => $r['guc'], 'orders' => array_map('trim', $r['orders'])], RlsProbeJob::$runs));
        $this->assertSame(0, $this->platformTable('failed_jobs')->count());

        // after the last job the session is empty again
        $this->assertSame('', $this->guc());
        $this->assertSame('', $this->guc('app.user_id'));
    }

    public function test_the_guc_follows_the_context_and_is_restored_after_an_exception(): void
    {
        $t = $this->twoTenantsWithOrders();
        [$a, $b] = [$t['a']['tenant']->id, $t['b']['tenant']->id];

        $this->tenancy()->set($a);
        $this->assertSame($a, $this->guc());
        $this->inTenant($b, fn () => $this->assertSame($b, $this->guc()));
        $this->assertSame($a, $this->guc());

        try {
            $this->inTenant($b, fn () => throw new RuntimeException('boom'));
        } catch (RuntimeException) {
        }
        $this->assertSame($a, $this->guc());

        $this->tenancy()->clear();
        $this->assertSame('', $this->guc());
    }

    public function test_a_new_request_starts_with_an_empty_session(): void
    {
        $t = $this->twoTenantsWithOrders();
        $this->setGuc($t['a']['tenant']->id, $t['a']['user']->id); // as if the previous request leaked

        $seen = app(ResetDatabaseTenant::class)->handle(Request::create('/'), fn () => new Response($this->guc().'|'.$this->guc('app.user_id')));
        $this->assertSame('|', $seen->getContent());

        // ...and end to end: a storefront request of B after the leak sees only B
        $this->setGuc($t['a']['tenant']->id);
        $this->sf($t['b']['store'], 'GET', '/config')->assertOk();
        $this->assertSame('', $this->guc(), 'the storefront middleware clears the tenant in `finally`');
    }

    public function test_switching_tenant_inside_a_transaction_is_refused(): void
    {
        $t = $this->twoTenantsWithOrders();
        [$a, $b] = [$t['a']['tenant']->id, $t['b']['tenant']->id];

        $this->tenancy()->set($a);
        try {
            DB::transaction(function () use ($a, $b) {
                $this->tenancy()->set($a); // same tenant: fine
                $this->tenancy()->run($b, fn () => null);
            });
            $this->fail('expected TenantSwitchInTransaction');
        } catch (TenantSwitchInTransaction) {
        }
        $this->assertSame($a, $this->tenancy()->id());
        $this->assertSame($a, $this->guc());
        $this->tenancy()->clear();

        // entering a tenant from "no tenant" inside a transaction is allowed (registration, invitations)
        DB::transaction(fn () => $this->inTenant($b, fn () => $this->assertSame($b, $this->guc())));
        $this->assertSame('', $this->guc());
    }

    public function test_a_reconnect_reapplies_the_current_tenant(): void
    {
        $t = $this->twoTenantsWithOrders();
        $this->tenancy()->set($t['b']['tenant']->id);

        DB::purge();
        DB::reconnect();

        $this->assertSame($t['b']['tenant']->id, $this->guc());
        $this->assertSame(1, DB::table('orders')->count());
        $this->tenancy()->clear();
    }
}
