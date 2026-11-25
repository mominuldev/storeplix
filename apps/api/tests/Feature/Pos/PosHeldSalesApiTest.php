<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\Models\Plan;
use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8D §9 (part B), P88D-16, S207: held sales park a cart per register (≤ 20), reserve no stock, resume through
 * the sale's `held_sale_id` (same register only, deleted by the sale), and are deleted when the register closes.
 */
#[Group('pos')]
class PosHeldSalesApiTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    private function hold(array $h, $store, string $session, array $lines, array $extra = [])
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/held-sales'), ['session_id' => $session, 'lines' => $lines] + $extra);
    }

    public function test_hold_list_show_delete_without_reserving_stock(): void
    {
        $s = $this->posShop(shopStock: 2, price: 45000);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'LOYAL5', 'type' => 'percentage', 'percent_bps' => 500, 'status' => 'active'])->assertCreated();
        $session = $this->posSession($s);

        $held = $this->hold($h, $store, $session, [['variant_id' => strtoupper($v), 'quantity' => 2]], [
            'customer' => ['phone' => '01711-552211', 'name' => 'Farhana Yasmin'], 'coupon_code' => 'loyal5', 'note' => '  Back after prayer ',
        ])->assertCreated()
            ->assertJsonPath('data.register_id', $s['register'])
            ->assertJsonPath('data.customer_id', null)
            ->assertJsonPath('data.customer_name', 'Farhana Yasmin')
            ->assertJsonPath('data.customer_phone', '8801711552211')
            ->assertJsonPath('data.coupon_code', 'LOYAL5')
            ->assertJsonPath('data.note', 'Back after prayer')
            ->assertJsonPath('data.lines', [['variant_id' => $v, 'quantity' => 2]])
            ->assertJsonPath('data.items_count', 2)
            ->assertJsonPath('data.total_amount', 85500)
            ->assertJsonPath('data.currency', 'BDT')
            ->assertJsonPath('data.held_by.id', fn ($id) => is_string($id))
            ->json('data');
        $walkIn = $this->hold($h, $store, $session, [['variant_id' => $v, 'quantity' => 1]])->assertCreated()
            ->assertJsonPath('data.customer_name', null)->assertJsonPath('data.customer_phone', null)->json('data.id');

        // No stock reserved: the shop still sells its 2 units while both are held.
        $this->assertSame(['on_hand' => 2, 'committed' => 0], $this->row($tenant, $v, $s['shop']));
        $this->cashSale($s, $session, 2);

        $this->api($h, 'GET', $this->pUrl($store, "/held-sales?register_id={$s['register']}"))->assertOk()
            ->assertJsonCount(2, 'data')->assertJsonPath('data.0.id', $walkIn)->assertJsonPath('data.1.id', $held['id']);
        $this->api($h, 'GET', $this->pUrl($store, "/held-sales/{$held['id']}"))->assertOk()->assertJsonPath('data.total_amount', 85500);
        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk()->assertJsonPath('data.totals.held_sales_count', 2);

        $this->api($h, 'DELETE', $this->pUrl($store, "/held-sales/{$walkIn}"))->assertNoContent();
        $this->api($h, 'GET', $this->pUrl($store, "/held-sales/{$walkIn}"))->assertNotFound();
        $this->api($h, 'DELETE', $this->pUrl($store, "/held-sales/{$walkIn}"))->assertNotFound();
        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'pos_held_sale.deleted')->get();
        $this->assertCount(1, $audit);
        $this->assertSame('pos_held_sale', $audit[0]->subject_type);
    }

    public function test_validation_limit_closed_register_and_plan(): void
    {
        $s = $this->posShop(price: 1000);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 1]];

        $this->hold($h, $store, $session, [])->assertStatus(422)->assertJsonValidationErrors(['lines'], 'error.details');
        $this->hold($h, $store, $session, $line, ['note' => str_repeat('n', 121)])->assertStatus(422)->assertJsonValidationErrors(['note'], 'error.details');
        $this->hold($h, $store, $session, [['variant_id' => (string) Str::ulid(), 'quantity' => 1]])->assertStatus(422)->assertJsonValidationErrors(['lines.0.variant_id'], 'error.details');
        $this->hold($h, $store, $session, $line, ['coupon_code' => 'NOPE'])->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid');
        $this->hold($h, $store, $session, $line, ['customer_id' => (string) Str::ulid()])->assertStatus(422)->assertJsonValidationErrors(['customer_id'], 'error.details');
        $this->api($h, 'GET', $this->pUrl($store, '/held-sales'))->assertStatus(422)->assertJsonValidationErrors(['register_id'], 'error.details');

        for ($i = 0; $i < PosHeldSale::MAX_PER_REGISTER; $i++) {
            $this->hold($h, $store, $session, $line)->assertCreated();
        }
        $this->hold($h, $store, $session, $line)->assertStatus(409)->assertJsonPath('error.code', 'held_sales_limit');
        // Another register has its own 20.
        $other = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $otherSession = $this->openRegister($h, $store, $other)->json('data.id');
        $this->hold($h, $store, $otherSession, $line)->assertCreated();

        $this->planFor($tenant, Plan::STARTER);
        $this->hold($h, $store, $otherSession, $line)->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'GET', $this->pUrl($store, "/held-sales?register_id={$other}"))->assertOk()->assertJsonCount(1, 'data'); // reads stay
        $this->planFor($tenant, Plan::GROWTH);

        $this->closeRegister($h, $store, $otherSession, ['counted_cash_amount' => 100000, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk();
        $this->hold($h, $store, $otherSession, $line)->assertStatus(409)->assertJsonPath('error.code', 'register_closed');
    }

    public function test_resume_completes_and_deletes_the_held_sale_of_the_same_register_only(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $session = $this->posSession($s);
        $held = $this->hold($h, $store, $session, [['variant_id' => $v, 'quantity' => 2]], ['note' => 'Blue one'])->json('data');
        $other = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $otherSession = $this->openRegister($h, $store, $other)->json('data.id');
        $line = [['variant_id' => $v, 'quantity' => 2]];

        // Another register of the same store can't complete it (S207).
        $this->sell($h, $store, $this->saleBody($otherSession, $line, 20000, ['held_sale_id' => $held['id']]))
            ->assertStatus(422)->assertJsonValidationErrors(['held_sale_id'], 'error.details');
        // Resumed lines are re-priced and re-checked: a price change is a 409 like any sale, and the held sale stays.
        $this->sell($h, $store, $this->saleBody($session, $line, $held['total_amount'] - 1, ['held_sale_id' => $held['id']]))->assertStatus(409);
        $this->api($h, 'GET', $this->pUrl($store, "/held-sales/{$held['id']}"))->assertOk();

        $sale = $this->sell($h, $store, $this->saleBody($session, $line, 20000, ['held_sale_id' => strtoupper($held['id'])]))->assertCreated()->json('data');
        $this->api($h, 'GET', $this->pUrl($store, "/held-sales/{$held['id']}"))->assertNotFound();
        $placed = collect($sale['order']['events'])->firstWhere('type', 'placed');
        $this->assertSame($held['id'], $placed['meta']['held_sale_id']);
        // Completing it twice is refused.
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 1]], 10000, ['held_sale_id' => $held['id']]))
            ->assertStatus(422)->assertJsonValidationErrors(['held_sale_id'], 'error.details');
    }

    public function test_close_deletes_the_registers_held_sales_and_audits_the_count(): void
    {
        $s = $this->posShop(price: 1000);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $session = $this->posSession($s, 0);
        foreach ([1, 2, 3] as $i) {
            $this->hold($h, $store, $session, [['variant_id' => $v, 'quantity' => $i]])->assertCreated();
        }
        $other = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $this->hold($h, $store, $this->openRegister($h, $store, $other)->json('data.id'), [['variant_id' => $v, 'quantity' => 1]])->assertCreated();

        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk()
            ->assertJsonPath('data.totals.held_sales_count', 0);
        $this->assertSame(0, $this->platformQuery(PosHeldSale::class)->where('register_id', $s['register'])->count());
        $this->assertSame(1, $this->platformQuery(PosHeldSale::class)->where('register_id', $other)->count());
        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'pos_session.closed')->value('meta'), true);
        $this->assertSame(3, $meta['held_sales_deleted']);
    }

    #[Group('security')]
    public function test_isolation_and_permissions(): void
    {
        $a = $this->posShop(slug: 'alpha');
        $b = $this->posShop(slug: 'beta');
        $bSession = $this->posSession($b);
        $bHeld = $this->hold($b['h'], $b['store'], $bSession, [['variant_id' => $b['variant'], 'quantity' => 1]])->json('data.id');
        $aSession = $this->posSession($a);
        $this->hold($a['h'], $a['store'], $aSession, [['variant_id' => $a['variant'], 'quantity' => 1]])->assertCreated();

        $this->assertTenantIsolation($a['h'], [
            ['GET', $this->pUrl($a['store'], "/held-sales/{$bHeld}")],
            ['DELETE', $this->pUrl($a['store'], "/held-sales/{$bHeld}")],
        ]);
        $this->api($a['h'], 'GET', $this->pUrl($a['store'], "/held-sales?register_id={$b['register']}"))->assertStatus(422);
        $this->hold($a['h'], $a['store'], $bSession, [['variant_id' => $a['variant'], 'quantity' => 1]])->assertStatus(422)->assertJsonValidationErrors(['session_id'], 'error.details');
        $this->sell($a['h'], $a['store'], $this->saleBody($aSession, [['variant_id' => $a['variant'], 'quantity' => 1]], $a['price'], ['held_sale_id' => $bHeld]))
            ->assertStatus(422)->assertJsonValidationErrors(['held_sale_id'], 'error.details');
        $this->assertStoreIsolation(PosHeldSale::class, $a['tenant'], $a['store'], $b['store']);

        [, $staff] = $this->memberAs($a['tenant'], TenantUser::ROLE_STAFF);
        $this->hold($staff, $a['store'], $aSession, [['variant_id' => $a['variant'], 'quantity' => 1]])->assertCreated();
        $viewer = $this->memberWithRole($a['tenant'], $this->customRole($a['h'], 'Viewer', ['orders.view']))[1];
        $this->api($viewer, 'GET', $this->pUrl($a['store'], "/held-sales?register_id={$a['register']}"))->assertForbidden();
        $this->hold($viewer, $a['store'], $aSession, [['variant_id' => $a['variant'], 'quantity' => 1]])->assertForbidden();
    }
}
