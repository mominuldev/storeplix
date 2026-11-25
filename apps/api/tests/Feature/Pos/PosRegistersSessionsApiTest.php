<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\Models\Plan;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8D §4 (part A): registers (P88D-4) and cash sessions (P88D-5, P88D-15): open with a counted float, live
 * totals, close with counted cash, variance vs tolerance, left in drawer and banked (S201), idempotency (S200), plan and
 * downgrade (S197), audit (P88D-23).
 */
#[Group('pos')]
class PosRegistersSessionsApiTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_register_crud_list_order_name_rules_and_audit(): void
    {
        $s = $this->posShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $warehouseRegister = $this->addRegister($h, $store, 'Back office', $s['main'])->assertCreated()
            ->assertJsonPath('data.location', ['id' => $s['main'], 'name' => 'Main warehouse', 'type' => 'warehouse'])
            ->assertJsonPath('data.open_session', null)->assertJsonPath('data.last_session', null)->assertJsonPath('data.archived_at', null)
            ->json('data.id');
        $this->addRegister($h, $store, 'register 1', $s['shop'])->assertStatus(422)->assertJsonPath('error.code', 'register_name_taken');
        $this->addRegister($h, $store, 'Register 2', (string) Str::ulid())->assertStatus(422)->assertJsonValidationErrors(['location_id'], 'error.details');
        $this->addRegister($h, $store, '   ', $s['shop'])->assertStatus(422)->assertJsonValidationErrors(['name'], 'error.details');
        $this->addRegister($h, $store, str_repeat('R', 41), $s['shop'])->assertStatus(422)->assertJsonValidationErrors(['name'], 'error.details');
        $old = $this->addLocation($h, $store, 'Old shop', 'shop')['id'];
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$old}/archive"))->assertOk();
        $this->addRegister($h, $store, 'Register 2', $old)->assertStatus(422)->assertJsonPath('error.code', 'location_archived');

        // Shops first, then the warehouse.
        $this->api($h, 'GET', $this->pUrl($store, '/registers'))->assertOk()
            ->assertJsonPath('data.0.id', $s['register'])->assertJsonPath('data.1.id', $warehouseRegister);

        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$warehouseRegister}"), ['name' => 'Counter', 'position' => 3])->assertOk()
            ->assertJsonPath('data.name', 'Counter')->assertJsonPath('data.position', 3);
        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$warehouseRegister}"), ['name' => 'REGISTER 1'])->assertStatus(422)->assertJsonPath('error.code', 'register_name_taken');
        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$warehouseRegister}"), ['location_id' => $s['shop']])->assertOk()->assertJsonPath('data.location.id', $s['shop']);

        // Archive frees the name; archived list; unarchive with the name taken again → 422.
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$warehouseRegister}/archive"))->assertOk()->assertJsonPath('data.archived_at', fn ($v) => is_string($v));
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$warehouseRegister}/archive"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'GET', $this->pUrl($store, '/registers?filter[archived]=true'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $warehouseRegister);
        $this->api($h, 'GET', $this->pUrl($store, '/registers'))->assertOk()->assertJsonCount(1, 'data');
        $this->addRegister($h, $store, 'Counter', $s['shop'])->assertCreated();
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$warehouseRegister}/unarchive"))->assertStatus(422)->assertJsonPath('error.code', 'register_name_taken');
        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$warehouseRegister}"), ['name' => 'Counter 2'])->assertOk();
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$warehouseRegister}/unarchive"))->assertOk()->assertJsonPath('data.archived_at', null);
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$warehouseRegister}/unarchive"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        $actions = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', 'pos_register.%')->pluck('action')->all();
        foreach (['pos_register.created', 'pos_register.updated', 'pos_register.archived', 'pos_register.unarchived'] as $action) {
            $this->assertContains($action, $actions);
        }
        $this->assertSame('pos_register', $this->platformTable('audit_logs')->where('action', 'pos_register.created')->value('subject_type'));
    }

    public function test_ten_active_registers_at_most(): void
    {
        $s = $this->posShop();
        for ($i = 2; $i <= 10; $i++) {
            $this->addRegister($s['h'], $s['store'], "Register {$i}", $s['shop'])->assertCreated();
        }
        $this->addRegister($s['h'], $s['store'], 'Register 11', $s['shop'])->assertStatus(409)->assertJsonPath('error.code', 'register_limit_reached');
        $this->api($s['h'], 'POST', $this->pUrl($s['store'], "/registers/{$s['register']}/archive"))->assertOk();
        $this->addRegister($s['h'], $s['store'], 'Register 11', $s['shop'])->assertCreated();
        $this->api($s['h'], 'POST', $this->pUrl($s['store'], "/registers/{$s['register']}/unarchive"))->assertStatus(409)->assertJsonPath('error.code', 'register_limit_reached');
    }

    public function test_open_with_counts_or_amount_one_open_session_and_idempotent_replay(): void
    {
        $s = $this->posShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $key = (string) Str::uuid();
        $body = ['counts' => ['100000' => 1, '50000' => 1, '10000' => 3, '500' => 2], 'opening_cash_amount' => 1, 'note' => 'Morning float'];

        $session = $this->openRegister($h, $store, $s['register'], $body, $key)->assertCreated()
            ->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.opening_cash_amount', 181000) // counts win over the amount
            ->assertJsonPath('data.opening_counts', ['100000' => 1, '50000' => 1, '10000' => 3, '500' => 2])
            ->assertJsonPath('data.register.name', 'Register 1')
            ->assertJsonPath('data.register.location.name', 'Mirpur shop')
            ->assertJsonPath('data.currency', 'BDT')
            ->assertJsonPath('data.tolerance_amount', 5000)
            ->assertJsonPath('data.last_closing_left_amount', null)
            ->assertJsonPath('data.totals.cash_in_drawer_amount', 181000)
            ->assertJsonPath('data.revision', 1)
            ->json('data');
        $this->openRegister($h, $store, $s['register'], $body, $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true')->assertJsonPath('data.id', $session['id']);
        $this->openRegister($h, $store, $s['register'], ['opening_cash_amount' => 5], $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->openRegister($h, $store, $s['register'], ['opening_cash_amount' => 0])->assertStatus(409)
            ->assertJsonPath('error.code', 'register_already_open')->assertJsonPath('error.details.session_id', $session['id']);
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$s['register']}/open"), ['opening_cash_amount' => 0])->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $this->assertSame(1, $this->platformQuery(PosSession::class)->where('tenant_id', $tenant->id)->count());

        $this->api($h, 'GET', $this->pUrl($store, '/registers'))->assertOk()->assertJsonPath('data.0.open_session.id', $session['id'])
            ->assertJsonPath('data.0.open_session.opened_by.id', fn ($v) => is_string($v));
        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'pos_session.opened')->value('meta'), true);
        $this->assertSame(181000, $meta['opening_cash_amount']);
        $this->assertSame('Morning float', $meta['note']);

        // Validation: bad denominations / counts, neither field.
        $other = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $this->openRegister($h, $store, $other, ['counts' => ['300' => 1]])->assertStatus(422)->assertJsonValidationErrors(['counts.300'], 'error.details');
        $this->openRegister($h, $store, $other, ['counts' => ['100000' => -1]])->assertStatus(422)->assertJsonValidationErrors(['counts.100000'], 'error.details');
        $this->openRegister($h, $store, $other, ['counts' => ['100000' => 10001]])->assertStatus(422);
        $this->openRegister($h, $store, $other, [])->assertStatus(422)->assertJsonValidationErrors(['opening_cash_amount'], 'error.details');
        $this->openRegister($h, $store, $other, ['opening_cash_amount' => -1])->assertStatus(422);
        $this->openRegister($h, $store, $other, ['opening_cash_amount' => 0])->assertCreated()->assertJsonPath('data.opening_counts', null);

        // An archived register can't open; an open one can't be archived or moved.
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$s['register']}/archive"))->assertStatus(409)->assertJsonPath('error.code', 'register_in_use');
        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$s['register']}"), ['location_id' => $s['main']])->assertStatus(409)->assertJsonPath('error.code', 'register_in_use');
        $third = $this->addRegister($h, $store, 'Register 3', $s['shop'])->json('data.id');
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$third}/archive"))->assertOk();
        $this->openRegister($h, $store, $third)->assertStatus(422)->assertJsonPath('error.code', 'register_archived');
    }

    public function test_close_maths_tolerance_note_left_and_banked_and_the_last_session_card(): void
    {
        $s = $this->posShop(shopStock: 10, price: 45000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $session = $this->posSession($s, 200000);
        $this->cashSale($s, $session, 2, ['tendered_cash_amount' => 100000]); // +90000 cash
        $this->cashSale($s, $session, 1, ['payments' => [['method' => 'bkash_personal', 'amount' => 45000]], 'tendered_cash_amount' => null]);

        $totals = $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk()->json('data.totals');
        $this->assertSame(290000, $totals['cash_in_drawer_amount']); // 200000 + 90000 (change never counts)
        $this->assertSame([90000, 0, 135000, 2, 0], [$totals['cash_sales_amount'], $totals['cash_refunds_amount'], $totals['sales_amount'], $totals['receipts_count'], $totals['held_sales_count']]);

        // Short by ৳ 200 (> ৳ 50 tolerance) without a note → 422 with the figures.
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 270000, 'left_in_drawer_amount' => 100000, 'revision' => 1])
            ->assertStatus(422)->assertJsonPath('error.code', 'close_note_required')
            ->assertJsonPath('error.details.variance_amount', -20000)->assertJsonPath('error.details.tolerance_amount', 5000);
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 270000, 'left_in_drawer_amount' => 270001, 'note' => 'x', 'revision' => 1])
            ->assertStatus(422)->assertJsonValidationErrors(['left_in_drawer_amount'], 'error.details');
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 270000, 'left_in_drawer_amount' => 0, 'note' => 'x', 'revision' => 7])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->closeRegister($h, $store, $session, ['left_in_drawer_amount' => 0, 'revision' => 1])->assertStatus(422)->assertJsonValidationErrors(['counted_cash_amount'], 'error.details');

        // Within tolerance (৳ 20 short) closes without a note; counts → counted.
        $key = (string) Str::uuid();
        $body = ['counts' => ['100000' => 2, '50000' => 1, '20000' => 1, '10000' => 1, '5000' => 1, '2000' => 1, '1000' => 1, '500' => 1, '200' => 1, '100' => 1],
            'left_in_drawer_amount' => 100000, 'revision' => 1];
        $closed = $this->closeRegister($h, $store, $session, $body, $key)->assertOk()
            ->assertJsonPath('data.status', 'closed')
            ->assertJsonPath('data.counted_cash_amount', 288800)
            ->assertJsonPath('data.expected_cash_amount', 290000)
            ->assertJsonPath('data.variance_amount', -1200)
            ->assertJsonPath('data.left_in_drawer_amount', 100000)
            ->assertJsonPath('data.banked_amount', 188800)
            ->assertJsonPath('data.close_note', null)
            ->assertJsonPath('data.closed_by.id', fn ($v) => is_string($v))
            ->assertJsonPath('data.totals.receipts_count', 2)
            ->assertJsonPath('data.revision', 2)
            ->json('data');
        $this->closeRegister($h, $store, $session, $body, $key)->assertOk()->assertHeader('Idempotent-Replayed', 'true')->assertJsonPath('data.id', $closed['id']);
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 2])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'pos_session.closed')->value('meta'), true);
        $this->assertSame([288800, 290000, -1200, 100000, 188800, 0], [$meta['counted_cash_amount'], $meta['expected_cash_amount'], $meta['variance_amount'], $meta['left_in_drawer_amount'], $meta['banked_amount'], $meta['held_sales_deleted']]);

        $this->api($h, 'GET', $this->pUrl($store, '/registers'))->assertOk()
            ->assertJsonPath('data.0.open_session', null)
            ->assertJsonPath('data.0.last_session', [
                'id' => $session, 'closed_at' => $closed['closed_at'], 'sales_amount' => 135000, 'receipts_count' => 2,
                'counted_cash_amount' => 288800, 'variance_amount' => -1200, 'banked_amount' => 188800, 'left_in_drawer_amount' => 100000,
            ]);
        // The next session's hint shows the left float.
        $this->openRegister($h, $store, $s['register'], ['opening_cash_amount' => 100000])->assertCreated()->assertJsonPath('data.last_closing_left_amount', 100000);
    }

    public function test_over_tolerance_closes_with_a_note(): void
    {
        $s = $this->posShop();
        $session = $this->posSession($s, 10000);
        $this->closeRegister($s['h'], $s['store'], $session, ['counted_cash_amount' => 20000, 'left_in_drawer_amount' => 0, 'note' => '  Owner added float  ', 'revision' => 1])
            ->assertOk()->assertJsonPath('data.variance_amount', 10000)->assertJsonPath('data.close_note', 'Owner added float')->assertJsonPath('data.banked_amount', 20000);
    }

    public function test_plan_gates_and_downgrade_keeps_reads_and_close(): void
    {
        $s = $this->posShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $session = $this->posSession($s);
        $spare = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $archived = $this->addRegister($h, $store, 'Register 3', $s['shop'])->json('data.id');
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$archived}/archive"))->assertOk();
        $this->planFor($tenant, Plan::STARTER);

        $this->addRegister($h, $store, 'Register 4', $s['shop'])->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$archived}/unarchive"))->assertStatus(402);
        $this->openRegister($h, $store, $spare)->assertStatus(402);
        // Allowed after a downgrade: reads, edit, archive, close.
        $this->api($h, 'GET', $this->pUrl($store, '/registers'))->assertOk();
        $this->api($h, 'PATCH', $this->pUrl($store, "/registers/{$spare}"), ['name' => 'Spare'])->assertOk();
        $this->api($h, 'POST', $this->pUrl($store, "/registers/{$spare}/archive"))->assertOk();
        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk();
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 100000, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk();

        // Free: same.
        $this->planFor($tenant, Plan::FREE);
        $this->addRegister($h, $store, 'Register 5', $s['shop'])->assertStatus(402);
    }

    public function test_permissions_staff_sells_but_cannot_manage_registers_and_custom_roles(): void
    {
        $s = $this->posShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        $session = $this->openRegister($staff, $store, $s['register'])->assertCreated()->json('data.id');
        $this->addRegister($staff, $store, 'Register 2', $s['shop'])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->api($staff, 'PATCH', $this->pUrl($store, "/registers/{$s['register']}"), ['name' => 'X'])->assertForbidden();
        $this->api($staff, 'POST', $this->pUrl($store, "/registers/{$s['register']}/archive"))->assertForbidden();
        $this->api($staff, 'GET', $this->pUrl($store, '/registers'))->assertOk();

        // A cashier-only custom role (pos.sell alone, no orders.view) sells; a role without pos.sell gets 403 everywhere.
        $cashierRole = $this->customRole($h, 'Cashier', ['pos.sell']);
        [, $cashier] = $this->memberWithRole($tenant, $cashierRole);
        $this->cashSale(['h' => $cashier] + $s, $session);
        $this->closeRegister($cashier, $store, $session, ['counted_cash_amount' => 200000, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk();
        $this->api($cashier, 'GET', "/api/v1/stores/{$store->id}/orders")->assertForbidden();

        $viewerRole = $this->customRole($h, 'Viewer', ['orders.view']);
        [, $viewer] = $this->memberWithRole($tenant, $viewerRole);
        foreach ([
            ['GET', '/registers'], ['GET', "/sessions/{$session}"], ['GET', "/catalog?register_id={$s['register']}"],
            ['GET', "/lookup?register_id={$s['register']}&code=X"], ['GET', '/customers/lookup?phone=01711000000'],
            ['POST', '/quote'], ['POST', '/sales'], ['POST', "/registers/{$s['register']}/open"], ['POST', "/sessions/{$session}/close"],
        ] as [$method, $path]) {
            $this->api($viewer + ['Idempotency-Key' => (string) Str::uuid()], $method, $this->pUrl($store, $path))->assertForbidden();
        }
    }

    #[Group('security')]
    public function test_cross_tenant_ids_are_404_and_rows_never_leak_across_stores(): void
    {
        $a = $this->posShop(slug: 'alpha');
        $b = $this->posShop(slug: 'beta');
        $bSession = $this->posSession($b);
        $bSale = $this->cashSale($b, $bSession);
        $aSession = $this->posSession($a);
        $this->cashSale($a, $aSession);
        $p = fn (string $suffix) => $this->pUrl($a['store'], $suffix);

        $this->assertTenantIsolation($a['h'], [
            ['PATCH', $p("/registers/{$b['register']}"), ['name' => 'Stolen']],
            ['POST', $p("/registers/{$b['register']}/archive")],
            ['POST', $p("/registers/{$b['register']}/unarchive")],
            ['GET', $p("/sessions/{$bSession}")],
            ['GET', $p("/sales/{$bSale['id']}")],
        ]);
        $key = ['Idempotency-Key' => (string) Str::uuid()];
        $this->api($a['h'] + $key, 'POST', $p("/registers/{$b['register']}/open"), ['opening_cash_amount' => 0])->assertNotFound();
        $this->api($a['h'] + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $p("/sessions/{$bSession}/close"), ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertNotFound();
        $this->api($a['h'], 'POST', $p("/sales/{$bSale['id']}/sms-receipt"))->assertNotFound();
        // B's store through A's tenant header → 404 (the {store} binding).
        $this->api($a['h'], 'GET', $this->pUrl($b['store'], '/registers'))->assertNotFound();
        // Ids in bodies and queries of another tenant → 422 (foreign-id rule).
        $this->api($a['h'], 'GET', $p("/catalog?register_id={$b['register']}"))->assertStatus(422)->assertJsonValidationErrors(['register_id'], 'error.details');
        $this->api($a['h'], 'GET', $p("/lookup?register_id={$b['register']}&code=X"))->assertStatus(422);
        $this->addRegister($a['h'], $a['store'], 'Sneaky', $b['shop'])->assertStatus(422)->assertJsonValidationErrors(['location_id'], 'error.details');

        foreach ([PosRegister::class, PosSession::class, PosSale::class] as $model) {
            $this->assertStoreIsolation($model, $a['tenant'], $a['store'], $b['store']);
        }
    }

    #[Group('security')]
    public function test_write_limiter_is_on_every_pos_write(): void
    {
        $writes = ['stores.pos.registers.store', 'stores.pos.registers.update', 'stores.pos.registers.archive', 'stores.pos.registers.unarchive',
            'stores.pos.registers.open', 'stores.pos.sessions.close', 'stores.pos.sales.store', 'stores.pos.sales.sms-receipt'];
        foreach ($writes as $name) {
            $this->assertContains('throttle:pos-write', app('router')->getRoutes()->getByName($name)->gatherMiddleware(), $name);
        }
        $this->assertContains('throttle:pos-lookup', app('router')->getRoutes()->getByName('stores.pos.customers.lookup')->gatherMiddleware());
        $this->assertContains('throttle:pos-sms', app('router')->getRoutes()->getByName('stores.pos.sales.sms-receipt')->gatherMiddleware());
        foreach (['stores.pos.registers.open' => 'pos.open', 'stores.pos.sessions.close' => 'pos.close', 'stores.pos.sales.store' => 'pos.sale'] as $name => $scope) {
            $this->assertContains("idempotent:{$scope}", app('router')->getRoutes()->getByName($name)->gatherMiddleware(), $name);
        }
    }
}
