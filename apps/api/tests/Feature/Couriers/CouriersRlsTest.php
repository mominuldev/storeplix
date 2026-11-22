<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/** 5b-3 tables under forced RLS (S19) and sp_route_key_owner() over courier accounts (B12). Postgres + RLS only. */
#[Group('rls')]
#[Group('tenancy')]
class CouriersRlsTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    private function account(Store $store): CourierAccount
    {
        $a = new CourierAccount;
        $a->forceFill(['store_id' => $store->id, 'provider' => 'pathao', 'mode' => 'sandbox', 'status' => 'connected',
            'credentials' => ['client_id' => 'c', 'client_secret' => 's', 'username' => 'u@example.test', 'password' => 'p'], 'route_key' => CourierAccount::newRouteKey()]);
        $a->setWebhookSecret('secret');
        $a->save();

        return $a;
    }

    public function test_courier_tables_are_invisible_across_tenants_and_route_keys_resolve_through_the_definer_function(): void
    {
        $t = $this->twoTenantsWithOrders();
        $accounts = [];
        foreach (['a', 'b'] as $k) {
            $accounts[$k] = $this->inTenant($t[$k]['tenant'], fn () => $this->account($t[$k]['store']));
        }

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame([$accounts['a']->id], DB::table('courier_accounts')->pluck('id')->all());
        $this->assertSame(0, DB::table('courier_accounts')->where('id', $accounts['b']->id)->update(['status' => 'error']));
        $this->assertSame(0, DB::table('courier_accounts')->where('id', $accounts['b']->id)->delete());
        $b = $t['b'];
        foreach ([
            'shipment_batches' => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $b['tenant']->id, 'store_id' => $b['store']->id, 'provider' => 'pathao', 'status' => 'queued', 'results' => '[]'],
            'courier_area_mappings' => ['tenant_id' => $b['tenant']->id, 'store_id' => $b['store']->id, 'provider' => 'pathao', 'district_code' => 'dhaka', 'thana_code' => '', 'label' => 'x'],
            'shipment_events' => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $b['tenant']->id, 'store_id' => $b['store']->id, 'shipment_id' => strtolower((string) Str::ulid()),
                'status' => 'booked', 'source' => 'poll', 'occurred_at' => now()],
        ] as $table => $row) {
            $this->assertSame('42501', $this->sqlState(fn () => DB::table($table)->insert($row)), "{$table}: cross-tenant insert");
        }

        $this->setGuc(null);
        $this->assertSame(0, DB::table('courier_accounts')->count(), 'no tenant: nothing');
        $row = DB::selectOne('select * from sp_route_key_owner(?, ?)', ['pathao', $accounts['b']->route_key]);
        $this->assertSame([$b['tenant']->id, $b['store']->id, $accounts['b']->id], [$row->tenant_id, $row->store_id, $row->account_id]);
        $this->assertSame([], DB::select('select * from sp_route_key_owner(?, ?)', ['steadfast', $accounts['b']->route_key]), 'provider must match');
        $this->assertSame([], DB::select('select * from sp_route_key_owner(?, ?)', ['sslcommerz', $accounts['b']->route_key]));
    }
}
