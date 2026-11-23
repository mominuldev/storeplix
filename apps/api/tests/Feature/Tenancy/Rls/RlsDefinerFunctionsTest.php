<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\Support\PreTenantLookup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * §2.3 / §2.6: the SECURITY DEFINER lookups of the pre-tenant request paths return ids only, return nothing for
 * unknown input, and are the ONLY way the app role sees those rows without a tenant.
 */
#[Group('rls')]
#[Group('tenancy')]
class RlsDefinerFunctionsTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

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
              where n.nspname = current_schema() and p.proname like 'sp\\_%'"
        ))->keyBy('proname');

        foreach (['sp_resolve_host', 'sp_invitation_by_token', 'sp_store_slug_taken', 'sp_payment_owner'] as $name) {
            $f = $functions->get($name);
            $this->assertNotNull($f, "{$name} missing");
            $this->assertTrue((bool) $f->prosecdef, "{$name} is not SECURITY DEFINER");
            $this->assertStringContainsString('search_path=public, pg_temp', (string) $f->config);
            $this->assertFalse((bool) $f->public_execute, "{$name} is executable by PUBLIC");
            $this->assertTrue((bool) $f->app_execute, "{$name} is not executable by the app role");
        }
    }

    public function test_resolve_host_returns_ids_only_nothing_for_unknown_and_flags_suspended(): void
    {
        $t = $this->twoTenantsWithOrders();
        $this->setGuc(null, null);
        $host = $this->host($t['b']['store']);

        $this->assertSame(0, DB::table('store_domains')->where('hostname', $host)->count(), 'base rows invisible without a tenant');

        $rows = DB::select('select * from sp_resolve_host(?)', [$host]);
        $this->assertCount(1, $rows);
        $this->assertSame(['tenant_id', 'store_id', 'suspended'], array_keys((array) $rows[0])); // PHASE-8-1 §4.1
        $this->assertSame($t['b']['tenant']->id, trim($rows[0]->tenant_id));
        $this->assertSame($t['b']['store']->id, trim($rows[0]->store_id));

        $this->assertSame([], DB::select('select * from sp_resolve_host(?)', ['unknown.storeplix.test']));
        $this->assertNull(app(PreTenantLookup::class)->resolveHost('unknown.storeplix.test'));

        $this->inTenant($t['b']['tenant'], fn () => Store::query()->whereKey($t['b']['store']->id)->update(['status' => Store::STATUS_SUSPENDED]));
        // PHASE-8-1 §4.1 (amends §9.4 B1): a suspended store still resolves, flagged.
        $rows = DB::select('select * from sp_resolve_host(?)', [$host]);
        $this->assertCount(1, $rows);
        $this->assertTrue((bool) $rows[0]->suspended);
        app(StorefrontResolver::class)->forget($host);
        $this->assertTrue(app(StorefrontResolver::class)->resolve($host)?->suspended);

        // the storefront of A still resolves through the definer function (B1)
        $resolved = app(StorefrontResolver::class)->resolve($this->host($t['a']['store']));
        $this->assertSame($t['a']['store']->id, $resolved?->storeId);
    }

    public function test_invitation_lookup_and_slug_check_cross_tenants_with_ids_only(): void
    {
        $t = $this->twoTenantsWithOrders();
        $token = Str::random(40);
        $invitation = $this->inTenant($t['b']['tenant'], fn () => StaffInvitation::query()->create([
            'email' => 'rls@example.com', 'role' => 'staff', 'token_hash' => StaffInvitation::hashToken($token),
            'invited_by' => $t['b']['user']->id, 'expires_at' => now()->addDay(), 'last_sent_at' => now(),
        ]));

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame(0, DB::table('staff_invitations')->count());
        $this->assertSame(
            ['invitation_id' => $invitation->id, 'tenant_id' => $t['b']['tenant']->id],
            app(PreTenantLookup::class)->invitationByTokenHash(StaffInvitation::hashToken($token)),
        );
        $this->assertNull(app(PreTenantLookup::class)->invitationByTokenHash(hash('sha256', 'nope')));

        $this->assertTrue(app(PreTenantLookup::class)->storeSlugTaken($t['b']['store']->slug));
        $this->assertFalse(app(PreTenantLookup::class)->storeSlugTaken('free-slug-'.Str::lower(Str::random(6))));
        $this->assertSame(0, DB::table('stores')->where('slug', $t['b']['store']->slug)->count());

        $this->assertSame([], DB::select('select * from sp_payment_owner(?)', [strtolower((string) Str::ulid())]));
    }
}
