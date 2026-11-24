<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\FraudGuard\Models\FraudGuardSetting;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-8 §8.1 merchant routes: settings, reset, overview, decision log, blocklist, check-a-number, release —
 * happy path, validation, permissions (S155), plan (S166), audit (S165), cross-tenant isolation (S154).
 */
#[Group('fraud')]
#[Group('security')]
class FraudGuardApiTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpGuard(throttle: $this->name() === 'test_check_a_number_is_limited_audited_masked_and_needs_the_plan');
    }

    public function test_settings_are_created_lazily_partially_updated_validated_reset_and_audited(): void
    {
        [$owner, $tenant, $store, $h] = $this->courierShop();
        $s = $this->api($h, 'GET', $this->gUrl($store, '/settings'))->assertOk()->json('data');
        $this->assertSame([
            'enabled' => false, // tests: FRAUD_GUARD_DEFAULT_ENABLED=false (production default true)
            'hold_enabled' => true, 'hold_below' => 60, 'advance_enabled' => true, 'advance_below' => 75,
            'advance_expiry_minutes' => 1440, 'advance_cancel_if_unpaid' => true, 'otp_enabled' => true,
            'block_returners' => true, 'block_after_returns' => 3, 'duplicates_enabled' => true, 'duplicate_window_hours' => 24,
            'daily_limit_enabled' => true, 'daily_limit' => 3, 'min_parcels' => 3, 'updated_by' => null,
        ], array_diff_key($s, ['updated_at' => true]));
        $this->assertSame(1, $this->inTenant($tenant, fn () => FraudGuardSetting::query()->count()));

        $this->guardSettings($h, $store, ['enabled' => true])->assertOk()->assertJsonPath('data.enabled', true)
            ->assertJsonPath('data.updated_by', ['id' => $owner->id, 'name' => $owner->name]);
        $this->guardSettings($h, $store, ['hold_below' => 50, 'advance_below' => 70, 'duplicate_window_hours' => 48])->assertOk()
            ->assertJsonPath('data.hold_below', 50)->assertJsonPath('data.duplicate_window_hours', 48);

        foreach ([
            ['hold_below' => 0], ['hold_below' => 101], ['advance_below' => 40], ['hold_below' => 75, 'advance_below' => 70],
            ['advance_expiry_minutes' => 60], ['duplicate_window_hours' => 5], ['daily_limit' => 51], ['block_after_returns' => 21],
            ['min_parcels' => 0], ['enabled' => 'yes'], ['hold_below' => '60'], ['tenant_id' => 'x'], ['vpn_enabled' => true],
        ] as $bad) {
            $this->guardSettings($h, $store, $bad)->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        }
        $this->assertSame(50, $this->api($h, 'GET', $this->gUrl($store, '/settings'))->json('data.hold_below'));

        $reset = $this->api($h, 'POST', $this->gUrl($store, '/settings/reset'))->assertOk()->json('data');
        $this->assertSame([true, 60, 75, 24], [$reset['enabled'], $reset['hold_below'], $reset['advance_below'], $reset['duplicate_window_hours']]);
        $this->assertSame(3, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'fraud.settings_updated')->count());
    }

    public function test_blocklist_add_list_search_unblock_and_conflicts(): void
    {
        [$owner, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false]);
        $this->manual($h, $store, $this->manualBody($variant, 1, ['contact' => ['phone' => '01788000111']]))->assertCreated();
        $created = $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000111', 'note' => '  Fake address  '])
            ->assertCreated()->json('data');
        $this->assertSame([
            'phone_masked' => '01788•••111', 'phone' => '8801788000111', 'reason' => 'manual', 'note' => 'Fake address', 'source' => 'staff',
            'returned_count' => 0, 'open_orders_count' => 1,
        ], array_intersect_key($created, array_flip(['phone_masked', 'phone', 'reason', 'note', 'source', 'returned_count', 'open_orders_count'])));
        $this->assertSame('Nusrat Jahan', $created['customer']['name']);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name, 'role_label' => 'Owner'], $created['created_by']);
        $this->assertSame('pending', $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders")->json('data.0.status'), 'blocking cancels nothing');

        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '+8801788000111'])->assertStatus(409)->assertJsonPath('error.code', 'already_blocked');
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '12345'])->assertStatus(422);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000222', 'note' => "a\x07b"])->assertStatus(422);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000222', 'note' => str_repeat('x', 201)])->assertStatus(422);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000222'])->assertCreated();

        $this->assertCount(2, $this->api($h, 'GET', $this->gUrl($store, '/blocked-numbers'))->json('data'));
        $this->assertSame(['8801788000222'], array_column($this->api($h, 'GET', $this->gUrl($store, '/blocked-numbers?q=0222'))->json('data'), 'phone'));
        $this->assertSame(2, $this->api($h, 'GET', $this->gUrl($store, '/overview'))->json('data.blocked_count'));

        // A custom role with fraud.manage but not customers.view sees the masked phone only (custom roles: Growth).
        $this->planFor($tenant, 'growth');
        [, $hm] = $this->memberWithRole($tenant, $this->customRole($h, 'Guard', ['orders.view', 'fraud.manage']));
        $row = $this->api($hm, 'GET', $this->gUrl($store, '/blocked-numbers'))->assertOk()->json('data.0');
        $this->assertNull($row['phone']);
        $this->assertNotEmpty($row['phone_masked']);

        $this->api($h, 'DELETE', $this->gUrl($store, '/blocked-numbers/'.$created['id']))->assertNoContent();
        $this->api($h, 'DELETE', $this->gUrl($store, '/blocked-numbers/'.$created['id']))->assertNotFound();
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000111'])->assertCreated(); // re-block after unblock
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'fraud.number_unblocked')->count());
        $this->assertSame(3, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'fraud.number_blocked')->count());
        $this->assertStringNotContainsString('8801788000111', (string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', 'fraud.%')->pluck('meta')->implode(' '));
    }

    public function test_check_a_number_is_limited_audited_masked_and_needs_the_plan(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, '01799000111', 3, 2);
        $data = $this->api($h, 'POST', $this->gUrl($store, '/check'), ['phone' => '+8801799000111'])->assertOk()->json('data');
        $this->assertSame('01799•••111', $data['phone_masked']);
        $this->assertSame(['careful', 60, 3, 5, false], [$data['tier'], $data['rate'], $data['delivered'], $data['total'], $data['blocked']]);
        $this->assertSame([['key' => 'shop', 'delivered' => 3, 'total' => 5]], $data['sources']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}$/', (string) $data['last_return_on']);
        $this->api($h, 'POST', $this->gUrl($store, '/check'), ['phone' => 'nope'])->assertStatus(422);

        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'fraud.number_checked')->first();
        $this->assertSame(['phone_masked' => '01799•••111', 'tier' => 'careful'], json_decode((string) $audit->meta, true));

        for ($i = 2; $i <= 30; $i++) {
            $this->api($h, 'POST', $this->gUrl($store, '/check'), ['phone' => '01799000111']);
        }
        $this->api($h, 'POST', $this->gUrl($store, '/check'), ['phone' => '01799000111'])->assertStatus(429);

        $this->planFor($tenant, 'free');
        $this->travel(2)->minutes();
        $this->api($h, 'POST', $this->gUrl($store, '/check'), ['phone' => '01799000111'])->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
    }

    public function test_free_plan_reads_work_and_writes_are_402(): void
    {
        [, $tenant, $store, $h] = $this->guardShop();
        $this->planFor($tenant, 'free');
        $this->api($h, 'GET', $this->gUrl($store, '/settings'))->assertOk();
        $this->api($h, 'GET', $this->gUrl($store, '/overview'))->assertOk();
        $this->api($h, 'GET', $this->gUrl($store, '/events'))->assertOk();
        $this->api($h, 'GET', $this->gUrl($store, '/blocked-numbers'))->assertOk();
        $this->guardSettings($h, $store, ['hold_below' => 'bad'])->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'POST', $this->gUrl($store, '/settings/reset'))->assertStatus(402);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01788000111'])->assertStatus(402);
    }

    public function test_overview_and_decision_log(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false, 'advance_enabled' => false]);
        $this->history($tenant, $store, $h, $variant, '01755000111', 1, 2);
        $this->sfCheckout($store, $variant, '01755000111')->assertCreated();
        $this->sfCheckout($store, $variant, '01755000222')->assertCreated();

        $o = $this->api($h, 'GET', $this->gUrl($store, '/overview'))->assertOk()->json('data');
        $this->assertSame(now('Asia/Dhaka')->format('Y-m'), $o['month']);
        $this->assertSame([3, 6, 'BDT'], [$o['rules_on'], $o['rules_total'], $o['currency']]);
        $this->assertSame(['held' => 1, 'blocked' => 0, 'duplicates' => 0, 'limited' => 0], $o['stopped']);
        $this->assertGreaterThanOrEqual(2, $o['orders_checked']);
        $this->assertSame(0, $this->api($h, 'GET', $this->gUrl($store, '/overview?month=2025-01'))->json('data.orders_checked'));
        $this->api($h, 'GET', $this->gUrl($store, '/overview?month=2025-13'))->assertStatus(422);

        $events = $this->api($h, 'GET', $this->gUrl($store, '/events'))->assertOk();
        $held = $events->json('data.0');
        $this->assertSame('held', $held['type']);
        $this->assertSame('01755•••111', $held['phone_masked']);
        $this->assertEquals(['tier' => 'risky', 'rate' => 33, 'delivered' => 1, 'total' => 3, 'reasons' => ['rate_below_hold']], $held['detail']); // jsonb: key order not kept
        $this->assertArrayHasKey('next_cursor', $events->json('meta'));
        $this->assertSame([], $this->api($h, 'GET', $this->gUrl($store, '/events?filter[type]=released,advance_paid'))->json('data'));
        $this->api($h, 'GET', $this->gUrl($store, '/events?filter[type]=nope'))->assertStatus(422);
        $this->assertStringNotContainsString('8801755000111', (string) $events->getContent());
    }

    public function test_staff_and_roles_without_fraud_manage_get_403_release_needs_orders_process(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, '01755000111', 1, 2);
        $held = $this->orderOf($tenant, $this->sfCheckout($store, $variant, '01755000111')->json('data.order.number'));
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        $this->planFor($tenant, 'growth');
        [, $viewer] = $this->memberWithRole($tenant, $this->customRole($h, 'Viewer', ['orders.view', 'customers.view']));
        foreach ([$staff, $viewer] as $hx) {
            foreach ([['GET', '/settings'], ['PATCH', '/settings'], ['POST', '/settings/reset'], ['GET', '/overview'], ['GET', '/events'],
                ['GET', '/blocked-numbers'], ['POST', '/blocked-numbers'], ['POST', '/check']] as [$method, $path]) {
                $this->api($hx, $method, $this->gUrl($store, $path), ['phone' => '01711000009'])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            }
        }
        $this->api($viewer, 'POST', $this->oUrl($store, $held->id, '/guard/release'))->assertForbidden();
        $this->assertSame('call_first', $this->api($viewer, 'GET', $this->oUrl($store, $held->id))->assertOk()->json('data.guard.hold'));
        $this->api($staff, 'POST', $this->oUrl($store, $held->id, '/guard/release'))->assertOk();
    }

    public function test_cross_tenant_access_is_404(): void
    {
        [, $tenantA, $storeA, $hA, $variantA] = $this->guardShop('alpha', settings: ['otp_enabled' => false, 'block_returners' => false]);
        [, $tenantB, $storeB, $hB, $variantB] = $this->guardShop('beta', settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenantB, $storeB, $hB, $variantB, '01755000111', 1, 2);
        $heldB = $this->orderOf($tenantB, $this->sfCheckout($storeB, $variantB, '01755000111')->json('data.order.number'));
        $blockedB = $this->api($hB, 'POST', $this->gUrl($storeB, '/blocked-numbers'), ['phone' => '01755000999'])->assertCreated()->json('data.id');

        $this->assertAllNotFound($hA, [
            ['GET', $this->gUrl($storeB, '/settings')], ['PATCH', $this->gUrl($storeB, '/settings'), ['enabled' => false]],
            ['POST', $this->gUrl($storeB, '/settings/reset')], ['GET', $this->gUrl($storeB, '/overview')], ['GET', $this->gUrl($storeB, '/events')],
            ['GET', $this->gUrl($storeB, '/blocked-numbers')], ['POST', $this->gUrl($storeB, '/blocked-numbers'), ['phone' => '01755000111']],
            ['DELETE', $this->gUrl($storeB, '/blocked-numbers/'.$blockedB)], ['POST', $this->gUrl($storeB, '/check'), ['phone' => '01755000111']],
            ['POST', $this->oUrl($storeB, $heldB->id, '/guard/release')],
        ]);
        // Tenant A's own routes with B's ids → 404 too.
        $this->api($hA, 'DELETE', $this->gUrl($storeA, '/blocked-numbers/'.$blockedB))->assertNotFound();
        $this->api($hA, 'POST', $this->oUrl($storeA, $heldB->id, '/guard/release'))->assertNotFound();
        $this->assertSame([], $this->api($hA, 'GET', $this->gUrl($storeA, '/events'))->json('data'));
        $this->assertSame('call_first', $this->orderOf($tenantB, $heldB->number)->guard_hold);
        $this->assertSame(0, $this->api($hA, 'POST', $this->gUrl($storeA, '/check'), ['phone' => '01755000111'])->json('data.total'));
        $this->assertNotNull($variantA);
    }

    /** @param list<array{0: string, 1: string, 2?: array<string, mixed>}> $requests */
    private function assertAllNotFound(array $h, array $requests): void
    {
        foreach ($requests as $request) {
            $this->api($h, $request[0], $request[1], $request[2] ?? [])->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    public function test_impersonation_reads_but_cannot_write_or_check_a_number(): void
    {
        [, $tenant, $store] = $this->guardShop();
        $this->useSpaBrowser();
        Mail::fake();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: guard settings', 'ZD-88', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];

        $this->browser('GET', $this->gUrl($store, '/settings'), [], $t)->assertOk();
        $this->browser('GET', $this->gUrl($store, '/blocked-numbers'), [], $t)->assertOk();
        $this->browser('PATCH', $this->gUrl($store, '/settings'), ['enabled' => false], $t)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01711000009'], $t)->assertForbidden();
        $this->browser('POST', $this->gUrl($store, '/check'), ['phone' => '01711000009'], $t)->assertForbidden();
    }
}
