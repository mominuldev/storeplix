<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\FraudGuard\Jobs\CheckOrderRisk;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S154 at the database (PHASE-8-8 §4, §9): the five guard tables are under forced RLS; `fraud:resolve-stale` and
 * `fraud:prune` discover cross-tenant and work under each tenant with RLS on. TENANCY_RLS=true on Postgres only.
 */
#[Group('fraud')]
#[Group('rls')]
#[Group('security')]
class FraudGuardRlsTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase;

    private const TABLES = ['fraud_guard_settings', 'blocked_phones', 'order_risk_checks', 'fraud_guard_events', 'checkout_otps'];

    public function test_guard_tables_are_isolated_and_the_commands_run_under_rls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpGuard();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h, $variant] = $this->guardShop($slug, settings: ['block_returners' => false]);
            $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000111'])->assertCreated();
            $this->otp($store, '01788000222')->assertOk();
            $this->history($tenant, $store, $h, $variant, '01788000333', 1, 2);
            $this->sfCheckout($store, $variant, '01788000333')->assertCreated(); // known number (1 delivered): held, no OTP
            $shops[$slug] = [$tenant, $store, $h, $variant];
        }
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB, , $variantB] = $shops['beta'];

        // A lost check in B: resolved by the sweep under RLS.
        Queue::fake([CheckOrderRisk::class]);
        $this->guardSettings($shops['beta'][2], $storeB, ['otp_enabled' => false])->assertOk();
        $lost = $this->sfCheckout($storeB, $variantB, '01788000444')->assertCreated()->json('data.order.number');
        $this->travel(11)->minutes();
        $this->artisan('fraud:resolve-stale')->assertSuccessful();
        $this->assertNull($this->orderOf($tenantB, $lost)->guard_hold);
        $this->travel(2)->days();
        $this->artisan('fraud:prune')->assertSuccessful();
        $this->assertSame(0, $this->platformTable('checkout_otps')->count());

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenantA->id]);
        foreach (['fraud_guard_settings', 'blocked_phones', 'order_risk_checks', 'fraud_guard_events'] as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into blocked_phones (id, tenant_id, store_id, phone, reason, source, created_at, updated_at) values (?, ?, ?, '8801788000999', 'manual', 'staff', now(), now())",
                [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused);

        DB::statement("select set_config('app.tenant_id', '', false)");
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
