<?php

declare(strict_types=1);

namespace Tests\Feature\StockTransfers;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** S187 at the database (PHASE-8-8C §3.2): the four part-B tables are under forced RLS. TENANCY_RLS=true on Postgres only. */
#[Group('stocktransfer')]
#[Group('rls')]
#[Group('security')]
class StockTransferRlsTest extends TestCase
{
    use RefreshDatabase, StockTransferFixtures;

    public function test_transfers_and_counts_are_isolated(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpLocations();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            $s = $this->transferShop(10, $slug);
            $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 2]], ['send' => true])->assertCreated();
            $count = $this->startCount($s['h'], $s['store'], $s['main'])->assertCreated()->json('data.id');
            $this->setCounted($s['h'], $s['store'], $count, array_values($this->countLines($s['h'], $s['store'], $count))[0], 7)->assertOk();
            $shops[$slug] = $s;
        }
        [$a, $b] = [$shops['alpha'], $shops['beta']];

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$a['tenant']->id]);
        foreach (['stock_transfers', 'stock_transfer_items', 'stock_counts', 'stock_count_items'] as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$a['tenant']->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into stock_counts (id, tenant_id, store_id, location_id, name, status, lines_count, counted_count, started_at, revision, created_at, updated_at) values (?, ?, ?, ?, 'Sneaky', 'cancelled', 0, 0, now(), 1, now(), now())",
                [strtolower((string) Str::ulid()), $b['tenant']->id, $b['store']->id, $b['main']]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused);

        DB::statement("select set_config('app.tenant_id', '', false)");
        foreach (['stock_transfers', 'stock_transfer_items', 'stock_counts', 'stock_count_items'] as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
