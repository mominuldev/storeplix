<?php

declare(strict_types=1);

namespace Tests\Feature\Ai;

use App\Domain\Ai\AiGenerationService;
use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * S330 at the database (the three part B tables under forced RLS; Postgres `api-rls` only; the ledger is append-only)
 * and S343 under a real race (Postgres + pcntl: 20 parallel requests with credits for 10 → exactly 10 charged).
 */
#[Group('ai')]
#[Group('security')]
class AiRlsRaceTest extends TestCase
{
    use AiFixtures, ForksRaces, RefreshDatabase;

    private const TABLES = ['ai_credit_accounts', 'ai_credit_ledger', 'ai_generations'];

    #[Group('rls')]
    public function test_part_b_tables_are_isolated_and_the_ledger_is_append_only(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpAi();
        $tenants = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->aiShop($slug);
            [, $media] = $this->productWithImages($h, $store);
            $this->describe($h, $store)->assertStatus(202);
            $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->assertStatus(202);
            $this->inTenant($tenant, fn () => app(AiCreditCharger::class)->adjust(5, 'Goodwill grant', User::factory()->create(), (string) Str::ulid(), 'h'));
            $tenants[] = $tenant;
        }
        $this->artisan('ai:prune')->assertSuccessful();

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenants[0]->id]);
        foreach (self::TABLES as $table) {
            $ids = array_values(array_unique(array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"))));
            $this->assertSame([$tenants[0]->id], $ids, $table);
        }
        foreach (['update ai_credit_ledger set credits = 999', 'delete from ai_credit_ledger'] as $sql) {
            try {
                DB::statement($sql);
                $this->fail("{$sql} must be refused");
            } catch (QueryException $e) {
                $this->assertStringContainsString('permission denied', $e->getMessage());
            }
        }
        DB::statement("select set_config('app.tenant_id', '', false)");
    }

    #[Group('race')]
    public function test_twenty_parallel_requests_with_credits_for_ten_charge_exactly_ten(): void
    {
        $this->requirePostgresRace();
        $this->setUpAi();
        try {
            [$owner, $tenant, $store] = $this->aiShop('race');
            config(['ai.costs.product_description' => 2]); // free 20 → 10 requests
            $results = $this->parallel(20, function (int $i) use ($owner, $tenant, $store) {
                return $this->inTenant($tenant, function () use ($owner, $store, $i) {
                    try {
                        app(AiGenerationService::class)->describe(Store::query()->findOrFail($store->id), ['name' => "Item {$i}"], $owner, 'race-key-'.$i);

                        return 202;
                    } catch (ApiException $e) {
                        return $e->getStatusCode();
                    }
                });
            });
            sort($results);
            $this->assertSame([...array_fill(0, 10, 202), ...array_fill(0, 10, 402)], $results);
            $consumes = $this->platformTable('ai_credit_ledger')->where('tenant_id', $tenant->id)->where('type', 'consume')->count();
            $this->assertSame(10, $consumes);
            $this->assertSame(10, $this->platformTable('ai_generations')->where('tenant_id', $tenant->id)->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
