<?php

declare(strict_types=1);

namespace Tests\Feature\Sms;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Sms\Overview\SmsSliceFixtures;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** PHASE-8-9A: the four new SMS tables are under forced RLS. TENANCY_RLS=true on Postgres only (CI api-rls). */
#[Group('sms')]
#[Group('rls')]
#[Group('security')]
class SmsRlsTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsSliceFixtures;

    private const TABLES = ['sms_credit_accounts', 'sms_credit_ledger', 'sms_templates', 'sms_sender_ids'];

    public function test_credit_accounts_ledger_templates_and_sender_ids_are_isolated(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->withoutMiddleware(ThrottleRequests::class);
        $shops = [];
        foreach (['alpha', 'beta'] as $i => $slug) {
            [, $tenant, $store, $h] = $this->smsShop($slug);
            $this->grantCredits($tenant, 100);
            $this->senderRow($tenant, $store, $i === 0 ? 'ALPHABD' : 'BETABD', 'pending');
            $this->api($h, 'PUT', $this->smsUrl($store, '/templates/order_confirmed/en'), ['body' => '{shop}: Order {number} confirmed.'])->assertOk();
            $shops[$slug] = ['tenant' => $tenant, 'store' => $store];
        }
        [$a, $b] = [$shops['alpha'], $shops['beta']];

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$a['tenant']->id]);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$a['tenant']->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into sms_credit_ledger (id, tenant_id, type, credits, balance_after, actor_type, created_at) values (?, ?, 'admin_adjust', 1000, 1100, 'platform', now())",
                [strtolower((string) Str::ulid()), $b['tenant']->id]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused, 'inserting a ledger row for another tenant must be refused');

        DB::statement("select set_config('app.tenant_id', '', false)");
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
