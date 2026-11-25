<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** S195 at the database (PHASE-8-8D §3.1): the POS tables are under forced RLS. TENANCY_RLS=true on Postgres only. */
#[Group('pos')]
#[Group('rls')]
#[Group('security')]
class PosRlsTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    private const TABLES = ['pos_registers', 'pos_sessions', 'pos_sales', 'pos_held_sales'];

    public function test_registers_sessions_sales_and_held_sales_are_isolated(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpLocations();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            $s = $this->posShop(slug: $slug);
            $session = $this->posSession($s);
            $this->cashSale($s, $session);
            $this->api($s['h'], 'POST', $this->pUrl($s['store'], '/held-sales'), ['session_id' => $session, 'lines' => [['variant_id' => $s['variant'], 'quantity' => 1]]])->assertCreated();
            $shops[$slug] = $s + ['session' => $session];
        }
        [$a, $b] = [$shops['alpha'], $shops['beta']];

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$a['tenant']->id]);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$a['tenant']->id], array_values(array_unique($tenants)), $table);
        }
        $this->assertSame(0, (int) DB::selectOne('select count(*) as c from payments where pos_session_id = ?', [$b['session']])->c);
        $refused = null;
        try {
            DB::insert("insert into pos_registers (id, tenant_id, store_id, location_id, name, position, created_at, updated_at) values (?, ?, ?, ?, 'Sneaky', 0, now(), now())",
                [strtolower((string) Str::ulid()), $b['tenant']->id, $b['store']->id, $b['shop']]);
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
