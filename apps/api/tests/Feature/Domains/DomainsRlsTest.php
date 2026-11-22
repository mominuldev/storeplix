<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Domains\Jobs\CheckDomainJob;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Support\PreTenantLookup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * PHASE-6 §3.2 / §3.4 with RLS on (CI `api-rls`): the B17/B18 definer functions, and the add/reclaim, `ask` and
 * `domains:check` paths working as storeplix_app.
 */
#[Group('rls')]
#[Group('tenancy')]
#[Group('domains')]
class DomainsRlsTest extends TestCase
{
    use DomainFixtures, RefreshDatabase, RlsFixtures {
        DomainFixtures::shop insteadof RlsFixtures;
        DomainFixtures::member insteadof RlsFixtures;
        DomainFixtures::api insteadof RlsFixtures;
        DomainFixtures::createProduct insteadof RlsFixtures;
        DomainFixtures::productImage insteadof RlsFixtures;
        DomainFixtures::simpleProduct insteadof RlsFixtures;
        DomainFixtures::variableProduct insteadof RlsFixtures;
        DomainFixtures::assertStoreIsolation insteadof RlsFixtures;
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_definer_functions_are_security_definer_with_a_fixed_search_path_and_not_public(): void
    {
        $functions = collect(DB::select(
            "select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config,
                    has_function_privilege('public', p.oid, 'execute') as public_execute,
                    has_function_privilege(current_user, p.oid, 'execute') as app_execute
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = current_schema() and p.proname in ('sp_domain_claim_state', 'sp_domain_allowed')"
        ))->keyBy('proname');
        $this->assertCount(2, $functions);
        foreach ($functions as $name => $f) {
            $this->assertTrue((bool) $f->prosecdef, "{$name} is not SECURITY DEFINER");
            $this->assertStringContainsString('search_path=public, pg_temp', (string) $f->config);
            $this->assertFalse((bool) $f->public_execute, "{$name} is executable by PUBLIC");
            $this->assertTrue((bool) $f->app_execute, "{$name} is not executable by the app role");
        }
    }

    public function test_claim_state_and_allowed_cross_tenants_with_ids_only(): void
    {
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, , $storeB, $hB] = $this->domainShop(slug: 'b');
        $id = $this->addDomain($hA, $storeA, 'shop.acme.com')->assertCreated()->json('data.id');
        $this->setGuc(null, null);
        $this->assertSame(0, DB::table('store_domains')->where('hostname', 'shop.acme.com')->count(), 'invisible without a tenant');

        $rows = DB::select('select * from sp_domain_claim_state(?)', ['shop.acme.com']);
        $this->assertCount(1, $rows);
        $this->assertSame(['tenant_id', 'store_id', 'domain_id', 'status', 'status_changed_at', 'unproven_since'], array_keys((array) $rows[0]));
        $claim = app(PreTenantLookup::class)->domainClaimState('shop.acme.com');
        $this->assertSame([$tenantA->id, $storeA->id, $id, 'pending_verification'], [$claim['tenant_id'], $claim['store_id'], $claim['domain_id'], $claim['status']]);
        $this->assertNull(app(PreTenantLookup::class)->domainClaimState('nobody.example.com'));

        // B sees A's host as taken (through the definer function, not the base table)
        $this->addDomain($hB, $storeB, 'shop.acme.com')->assertStatus(422)->assertJsonPath('error.code', 'domain_taken');

        $this->assertFalse(app(PreTenantLookup::class)->domainAllowed('shop.acme.com'));
        $this->activeDomain($hA, $tenantA, $storeA, 'live.acme.com');
        $this->setGuc(null, null);
        $this->assertTrue(app(PreTenantLookup::class)->domainAllowed('live.acme.com'));
        $this->assertTrue((bool) DB::selectOne('select sp_domain_allowed(?) as a', [$storeB->slug.'.storeplix.test'])->a);
        $this->flushHeaders()->getJson('/api/v1/internal/domains/allowed?domain=live.acme.com&key=test-ask-key-0123456789abcdef0123')->assertOk();
    }

    public function test_reclaim_across_tenants_and_scheduler_discovery_with_rls(): void
    {
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, $tenantB, $storeB, $hB] = $this->domainShop(slug: 'b');
        $old = $this->addDomain($hA, $storeA, 'shop.acme.com')->json('data.id');
        $this->ageDomain($tenantA, $old, 73);
        $this->check($tenantA, $old);
        $this->ageDomain($tenantA, $old, 24 * 8);
        $this->addDomain($hB, $storeB, 'shop.acme.com')->assertCreated();
        $this->inTenant($tenantA, fn () => $this->assertSame(0, StoreDomain::query()->where('type', 'custom')->count()));
        $this->inTenant($tenantB, fn () => $this->assertSame(1, StoreDomain::query()->where('type', 'custom')->count()));

        Queue::fake();
        $this->travel(2)->minutes();
        $this->artisan('domains:check')->expectsOutputToContain('Dispatched 1')->assertSuccessful();
        Queue::assertPushed(CheckDomainJob::class, fn ($j) => $j->tenantId === $tenantB->id);
    }
}
