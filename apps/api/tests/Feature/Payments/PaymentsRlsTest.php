<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Payments\Models\PaymentGatewayAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PaymentGatewayFixtures;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/** 5b-2 tables under forced RLS (S19) and the B12 route-key definer function (P5B-19). Postgres + RLS only. */
#[Group('rls')]
#[Group('tenancy')]
class PaymentsRlsTest extends TestCase
{
    use PaymentGatewayFixtures, RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_gateway_rows_are_invisible_across_tenants_and_route_keys_resolve_through_the_definer_function(): void
    {
        $t = $this->twoTenantsWithOrders();
        $accounts = [];
        foreach (['a', 'b'] as $k) {
            $accounts[$k] = $this->inTenant($t[$k]['tenant'], fn () => $this->gatewayAccount($t[$k]['store'], 'sslcommerz', ['store_id' => 's', 'store_passwd' => 'p']));
        }

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame([$accounts['a']->id], DB::table('payment_gateway_accounts')->pluck('id')->all());
        $this->assertSame(0, DB::table('payment_gateway_accounts')->where('id', $accounts['b']->id)->update(['enabled' => true]));
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('webhook_events')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $t['b']['tenant']->id, 'store_id' => $t['b']['store']->id,
            'provider' => 'sslcommerz', 'account_id' => $accounts['b']->id, 'event_id' => 'x', 'payload' => '{}', 'received_at' => now(),
        ])));

        $this->setGuc(null);
        $this->assertSame(0, DB::table('payment_gateway_accounts')->count(), 'no tenant: nothing');
        $row = DB::selectOne('select * from sp_route_key_owner(?, ?)', ['sslcommerz', $accounts['b']->route_key]);
        $this->assertSame([$t['b']['tenant']->id, $t['b']['store']->id, $accounts['b']->id], [$row->tenant_id, $row->store_id, $row->account_id]);
        $this->assertSame([], DB::select('select * from sp_route_key_owner(?, ?)', ['bkash', $accounts['b']->route_key]), 'provider must match');
        $this->assertSame([], DB::select('select * from sp_route_key_owner(?, ?)', ['sslcommerz', PaymentGatewayAccount::newRouteKey()]));

        $f = DB::selectOne("select p.prosecdef, array_to_string(p.proconfig, ',') as config, has_function_privilege('public', p.oid, 'execute') as public_execute
            from pg_proc p where p.proname = 'sp_route_key_owner'");
        $this->assertTrue((bool) $f->prosecdef);
        $this->assertStringContainsString('search_path=public, pg_temp', (string) $f->config);
        $this->assertFalse((bool) $f->public_execute);
    }
}
