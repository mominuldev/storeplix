<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Orders\Models\Order;
use App\Domain\Tracking\TrackingRecorder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * S330 at the database (the six part A tables under forced RLS; Postgres `api-rls` only) and S336 under a real race
 * (Postgres + pcntl: the same order confirmed / recorded in parallel produces one server event per destination).
 */
#[Group('integrations')]
#[Group('tracking')]
#[Group('feeds')]
#[Group('security')]
class IntegrationsRlsTest extends TestCase
{
    use ForksRaces, IntegrationFixtures, RefreshDatabase;

    private const TABLES = ['store_integrations', 'tracking_events', 'tracking_daily_stats', 'order_tracking_contexts', 'catalog_sync_runs', 'catalog_items'];

    #[Group('rls')]
    public function test_part_a_tables_are_isolated_under_rls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpIntegrations();
        Storage::fake('public');
        Storage::fake('local');
        $tenants = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->liveShop($slug);
            $this->planFor($tenant, 'starter');
            $this->createProduct($h, $store, $this->simpleProduct('Shirt', 50000, ['status' => 'active', 'images' => [['media_id' => $this->productImage($h)]]], ['initial_on_hand' => 9]));
            [, $variant] = $this->stocked($h, $store, 50000, 9);
            $this->connect($h, $store, 'meta_pixel')->assertOk();
            $this->connectFeed($h, $store);
            $order = $this->trackedOrder($store, $variant, ['consent' => 'granted']);
            $this->confirm($h, $store, $order);
            $this->beacon($store, [self::browserEvent('page_view')])->assertStatus(202);
            $tenants[] = $tenant;
        }
        $this->artisan('tracking:dispatch-due')->assertSuccessful();
        $this->artisan('feeds:sync')->assertSuccessful();
        $this->artisan('integrations:health')->assertSuccessful();
        $this->artisan('tracking:prune')->assertSuccessful();

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenants[0]->id]);
        foreach (self::TABLES as $table) {
            $ids = array_values(array_unique(array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"))));
            $this->assertSame([$tenants[0]->id], $ids, $table);
        }
        DB::statement("select set_config('app.tenant_id', '', false)");
    }

    #[Group('race')]
    public function test_parallel_purchase_recording_creates_one_event_per_destination(): void
    {
        $this->requirePostgresRace();
        $this->setUpIntegrations();
        try {
            [, $tenant, $store, $h] = $this->liveShop('race');
            [, $variant] = $this->stocked($h, $store, 50000, 9);
            $this->connect($h, $store, 'meta_pixel')->assertOk();
            $this->connect($h, $store, 'ga4')->assertOk();
            $order = $this->trackedOrder($store, $variant);
            $this->platformTable('orders')->where('id', $order)->update(['status' => 'confirmed']);
            $results = $this->parallel(8, function () use ($tenant, $order) {
                $this->inTenant($tenant, fn () => DB::transaction(fn () => TrackingRecorder::purchase(Order::query()->findOrFail($order), ['order_confirmed'])));

                return 200;
            });
            $this->assertSame(array_fill(0, 8, 200), $results);
            $this->assertSame(2, $this->platformTable('tracking_events')->where('order_id', $order)->count());
            $this->assertSame(1, $this->platformTable('tracking_events')->where('order_id', $order)->where('provider', 'meta_pixel')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
