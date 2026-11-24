<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\RiskTier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S163: the SQL form of RiskTier (campaign audiences, list filters) equals the PHP form on random own-shop counters,
 * with the defaults and with custom thresholds; exactly one tier matches every row.
 */
#[Group('fraud')]
class RiskTierSqlTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase;

    public function test_sql_form_equals_php_form_for_random_fixtures(): void
    {
        [, $tenant, $store] = $this->courierShop();
        mt_srand(8808);
        $rows = [];
        $this->inTenant($tenant, function () use ($store, &$rows) {
            for ($i = 0; $i < 160; $i++) {
                [$d, $r] = $i < 40 ? [intdiv($i, 7), $i % 7] : [mt_rand(0, 60), mt_rand(0, 40)];
                $c = new Customer(['name' => "C{$i}", 'phone' => '88017'.str_pad((string) (10000000 + $i), 8, '0', STR_PAD_LEFT)]);
                $c->store_id = $store->id;
                $c->delivered_orders_count = $d;
                $c->returned_orders_count = $r;
                $c->save();
                $rows[$c->id] = [$d, $r];
            }
        });

        foreach ([null, ['hold_below' => 50, 'advance_below' => 90, 'min_parcels' => 5], ['hold_below' => 75, 'advance_below' => 75, 'min_parcels' => 1]] as $t) {
            $this->inTenant($tenant, function () use ($rows, $t, $store) {
                $bySql = [];
                foreach (RiskTier::ALL as $tier) {
                    foreach (Customer::query()->where('store_id', $store->id)->whereRaw(RiskTier::sql($tier, $t, 'customers.'))->pluck('id') as $id) {
                        $this->assertArrayNotHasKey($id, $bySql, 'one tier per row');
                        $bySql[$id] = $tier;
                    }
                }
                foreach ($rows as $id => [$d, $r]) {
                    $this->assertSame(RiskTier::classify($d, $r, $t), $bySql[$id] ?? null, "{$d}/{$r} ".json_encode($t));
                }
            });
        }
    }
}
