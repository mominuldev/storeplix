<?php

declare(strict_types=1);

namespace Tests\Feature\StockTransfers;

use App\Domain\Billing\Models\Plan;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockCountItem;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8C §8, §9 stock counts: start / scan / set / finish (P88C-11) with the delta-at-count vectors (S190), values
 * only with costs.view (S191), scan input (S193), one open count per location, too large, isolation (S187),
 * permissions and audit (S194). No plan gate (P88C-13).
 */
#[Group('stocktransfer')]
class StockCountsApiTest extends TestCase
{
    use RefreshDatabase, StockTransferFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    /** @return array{0: array<string, mixed>, 1: string, 2: string} shop, variant A (SKU PJ-RED-M, cost 400), variant B (barcode, cost 1000) */
    private function countShop(string $slug = 'shop'): array
    {
        $s = $this->transferShop(10, $slug, ['sku' => 'PJ-RED-M', 'cost_amount' => 40000]);
        [, $b] = $this->stocked($s['h'], $s['store'], stock: 5, variant: ['sku' => 'SAREE-1', 'barcode' => '8901234567890', 'cost_amount' => 100000]);

        return [$s, $s['variant'], $b];
    }

    public function test_start_scan_set_and_finish(): void
    {
        [$s, $a, $b] = $this->countShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $this->stocked($h, $store, stock: 3, variant: ['track_inventory' => false]); // untracked: no line
        $this->createProduct($h, $store, $this->simpleProduct('Draft kurta', 50000, ['status' => 'draft'], ['initial_on_hand' => 3])); // draft: no line

        $count = $this->startCount($h, $store, $s['main'])->assertCreated()
            ->assertJsonPath('data.status', 'in_progress')
            ->assertJsonPath('data.location.id', $s['main'])
            ->assertJsonPath('data.lines_count', 2)
            ->assertJsonPath('data.counted_count', 0)
            ->assertJsonPath('data.currency', 'BDT')
            ->assertJsonPath('data.zero_uncounted', null)
            ->assertJsonPath('data.summary.not_counted', 2)
            ->json('data');
        $this->assertSame('Count '.now('Asia/Dhaka')->format('j M').' · Main warehouse', $count['name']);
        $lines = $this->countLines($h, $store, $count['id']);
        $this->assertEqualsCanonicalizing([$a, $b], array_keys($lines));

        // Scan: SKU (case-insensitive, trimmed) +1; barcode +1.
        $r = $this->scan($h, $store, $count['id'], '  pj-red-m ')->assertOk()
            ->assertJsonPath('data.line.variant.id', $a)
            ->assertJsonPath('data.line.counted', 1)
            ->assertJsonPath('data.line.expected', 10)
            ->assertJsonPath('data.line.difference', -9)
            ->assertJsonPath('data.line.on_hand', 10)
            ->assertJsonPath('data.count.counted_count', 1)
            ->assertJsonPath('data.count.revision', 2);
        $this->assertNotNull($r->json('data.line.counted_by'));
        $this->scan($h, $store, $count['id'], '8901234567890')->assertOk()->assertJsonPath('data.line.variant.barcode', '8901234567890')->assertJsonPath('data.line.counted', 1);
        $this->scan($h, $store, $count['id'], 'SAREE-1')->assertOk()->assertJsonPath('data.line.counted', 2);
        // Set a quantity on a line.
        $this->setCounted($h, $store, $count['id'], $lines[$a], 8)->assertOk()
            ->assertJsonPath('data.line.counted', 8)
            ->assertJsonPath('data.summary', [
                'short_units' => 5, 'short_value_amount' => 2 * 40000 + 3 * 100000, 'extra_units' => 0, 'extra_value_amount' => 0,
                'not_counted' => 0, 'matched' => 0, 'differences' => 2, 'net_value_amount' => -(2 * 40000 + 3 * 100000),
            ]);
        $this->setCounted($h, $store, $count['id'], $lines[$a], 8, ['revision' => 2])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');

        $this->finishCount($h, $store, $count['id'])->assertOk()
            ->assertJsonPath('data.status', 'completed')
            ->assertJsonPath('data.zero_uncounted', false)
            ->assertJsonPath('data.net_value_amount', -380000);
        $this->assertSame(8, $this->onHand($tenant, $a, $s['main']));
        $this->assertSame(2, $this->onHand($tenant, $b, $s['main']));
        $ledger = $this->ledger($tenant, $a, 'count');
        $this->assertSame([['reason' => 'count', 'delta' => -2, 'location_id' => $s['main'], 'reference_type' => 'stock_count', 'note' => $count['name']]], $ledger);
        $done = $this->api($h, 'GET', $this->lUrl($store, "/stock-counts/{$count['id']}/lines"))->assertOk()->json('data');
        $this->assertEqualsCanonicalizing([-2, -3], array_column($done, 'applied_delta'));

        // Completed counts are read-only.
        $this->scan($h, $store, $count['id'], 'PJ-RED-M')->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->setCounted($h, $store, $count['id'], $lines[$a], 1)->assertStatus(409);
        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$count['id']}/cancel"))->assertStatus(409);
    }

    /** S190: a sale shipped and a receipt booked after a line was counted are kept; uncounted keep vs zero. */
    public function test_delta_at_count_vectors(): void
    {
        [$s, $a, $b] = $this->countShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        [, $c] = $this->stocked($h, $store, stock: 4);
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');
        $lines = $this->countLines($h, $store, $count);

        $this->setCounted($h, $store, $count, $lines[$a], 10)->assertOk()->assertJsonPath('data.line.expected', 10); // matched
        $this->setCounted($h, $store, $count, $lines[$b], 3)->assertOk()->assertJsonPath('data.line.expected', 5);   // 2 short

        // After counting: an order for 2 × A is placed and shipped; 4 × B are received.
        $order = $this->manual($h, $store, $this->manualBody($a, 2, ['notify_customer' => false]))->assertCreated()->json('data.id');
        foreach (['confirm', 'ship'] as $step) {
            $this->api($h, 'POST', $this->lUrl($store, "/orders/{$order}/{$step}"), ['notify_customer' => false])->assertOk();
        }
        $this->adjustAt($h, $store, [['variant_id' => $b, 'mode' => 'delta', 'quantity' => 4]])->assertOk();
        $this->assertSame(8, $this->onHand($tenant, $a, $s['main']));
        $this->assertSame(9, $this->onHand($tenant, $b, $s['main']));

        $this->finishCount($h, $store, $count, zero: true)->assertOk()->assertJsonPath('data.zero_uncounted', true);
        $this->assertSame(8, $this->onHand($tenant, $a, $s['main'])); // delta 0: the sale is kept (not "set to 10")
        $this->assertSame(7, $this->onHand($tenant, $b, $s['main'])); // 9 − 2: the receipt is kept
        $this->assertSame(0, $this->onHand($tenant, $c, $s['main'])); // uncounted + "set to 0"
        $this->assertSame([], $this->ledger($tenant, $a, 'count'));
        $this->assertSame([-4], array_column($this->ledger($tenant, $c, 'count'), 'delta'));

        // Keep stock (default): uncounted lines don't move; a re-count after more sales still applies only the delta.
        $count2 = $this->startCount($h, $store, $s['main'])->assertCreated()->json('data.id');
        $lines2 = $this->countLines($h, $store, $count2);
        $this->setCounted($h, $store, $count2, $lines2[$b], 7)->assertOk();
        $this->setCounted($h, $store, $count2, $lines2[$a], 5)->assertOk();     // expected 8 → −3
        $this->setCounted($h, $store, $count2, $lines2[$a], null)->assertOk()  // un-count
            ->assertJsonPath('data.line.counted', null)->assertJsonPath('data.line.expected', null)->assertJsonPath('data.count.counted_count', 1);
        $this->finishCount($h, $store, $count2)->assertOk();
        $this->assertSame(8, $this->onHand($tenant, $a, $s['main']));
        $this->assertSame(7, $this->onHand($tenant, $b, $s['main']));
        // A loss larger than what's left (sold meanwhile) stops at 0.
        $count3 = $this->startCount($h, $store, $s['main'])->json('data.id');
        $this->setCounted($h, $store, $count3, $this->countLines($h, $store, $count3)[$a], 0)->assertOk(); // expected 8 → −8
        $this->adjustAt($h, $store, [['variant_id' => $a, 'mode' => 'set', 'quantity' => 5]])->assertOk();
        $this->finishCount($h, $store, $count3)->assertOk();
        $this->assertSame(0, $this->onHand($tenant, $a, $s['main']));
        $this->assertSame(-5, $this->platformQuery(StockCountItem::class)->where('stock_count_id', $count3)->where('variant_id', $a)->value('applied_delta'));
    }

    public function test_one_open_count_per_location_category_scope_and_too_large(): void
    {
        [$s, $a] = $this->countShop();
        [$h, $store] = [$s['h'], $s['store']];
        $first = $this->startCount($h, $store, $s['main'])->json('data.id');
        $this->startCount($h, $store, $s['main'])->assertStatus(409)->assertJsonPath('error.code', 'count_in_progress')->assertJsonPath('error.details.count_id', $first);
        $this->startCount($h, $store, $s['shop'], ['name' => 'Shop shelf count'])->assertCreated()
            ->assertJsonPath('data.name', 'Shop shelf count')->assertJsonPath('data.lines_count', 2);
        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$first}/cancel"))->assertOk()->assertJsonPath('data.status', 'cancelled');
        $this->finishCount($h, $store, $first)->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        // Category scope includes sub-categories.
        $parent = $this->api($h, 'POST', $this->lUrl($store, '/categories'), ['name' => 'Men'])->assertCreated()->json('data.id');
        $child = $this->api($h, 'POST', $this->lUrl($store, '/categories'), ['name' => 'Panjabi', 'parent_id' => $parent])->assertCreated()->json('data.id');
        $p = $this->stocked($h, $store, stock: 2, extra: ['category_ids' => [$child]])[1];
        $byCat = $this->startCount($h, $store, $s['main'], ['category_id' => $parent])->assertCreated()
            ->assertJsonPath('data.category', ['id' => $parent, 'name' => 'Men'])->assertJsonPath('data.lines_count', 1)->json('data.id');
        $this->assertSame([$p], array_keys($this->countLines($h, $store, $byCat)));
        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$byCat}/cancel"))->assertOk();

        // Validation and archived location.
        $this->api($h, 'POST', $this->lUrl($store, '/stock-counts'), [])->assertUnprocessable()->assertJsonValidationErrors(['location_id'], 'error.details');
        $this->startCount($h, $store, $s['main'], ['name' => str_repeat('a', 81)])->assertUnprocessable();
        $this->startCount($h, $store, $s['main'], ['category_id' => strtolower((string) Str::ulid())])->assertUnprocessable()->assertJsonValidationErrors(['category_id'], 'error.details');
        $old = $this->addLocation($h, $store, 'Old godown', 'warehouse')['id'];
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$old}/archive"))->assertOk();
        $this->startCount($h, $store, $old)->assertUnprocessable()->assertJsonPath('error.code', 'location_archived');

        // > 5,000 lines → 422 count_too_large.
        $product = $this->platformQuery(ProductVariant::class)->whereKey($a)->value('product_id');
        $now = now();
        $rows = [];
        for ($i = 0; $i < StockCount::MAX_LINES; $i++) {
            $rows[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $s['tenant']->id, 'store_id' => $store->id, 'product_id' => $product,
                'title' => "Bulk {$i}", 'option1' => "b{$i}", 'price_amount' => 100, 'created_at' => $now, 'updated_at' => $now];
        }
        foreach (array_chunk($rows, 500) as $chunk) {
            $this->platformTable('product_variants')->insert($chunk);
        }
        $this->startCount($h, $store, $s['main'])->assertUnprocessable()->assertJsonPath('error.code', 'count_too_large')
            ->assertJsonPath('error.details', ['lines' => StockCount::MAX_LINES + 3, 'max' => StockCount::MAX_LINES]);
    }

    #[Group('security')]
    public function test_scan_input_is_literal_and_scoped_to_the_count(): void
    {
        [$s, $a] = $this->countShop('alpha');
        [$h, $store] = [$s['h'], $s['store']];
        [, $under] = $this->stocked($h, $store, stock: 1, variant: ['sku' => 'A_1']);
        $other = $this->transferShop(10, 'beta', ['sku' => 'BETA-ONLY']);
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');

        $this->scan($h, $store, $count, 'a_1')->assertOk()->assertJsonPath('data.line.variant.id', $under);
        $this->scan($h, $store, $count, 'A%1')->assertNotFound()->assertJsonPath('error.code', 'count_line_not_found')->assertJsonPath('error.details.code', 'A%1');
        $this->scan($h, $store, $count, 'AB1')->assertNotFound(); // `_` is not a wildcard
        $this->scan($h, $store, $count, '%')->assertNotFound();
        $this->scan($h, $store, $count, 'PJ-RED')->assertNotFound(); // no prefix match
        $this->scan($h, $store, $count, 'BETA-ONLY')->assertNotFound(); // another tenant's SKU
        $this->scan($h, $store, $count, str_repeat('A', 65))->assertUnprocessable()->assertJsonValidationErrors(['code'], 'error.details');
        $this->scan($h, $store, $count, '   ')->assertUnprocessable();
        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$count}/scan"), ['code' => ['x']])->assertUnprocessable();
        $this->assertSame(10, $this->onHand($other['tenant'], $other['variant'], $other['main']));

        // Set-line bounds.
        $line = $this->countLines($h, $store, $count)[$a];
        $this->setCounted($h, $store, $count, $line, -1)->assertUnprocessable();
        $this->setCounted($h, $store, $count, $line, 1000001)->assertUnprocessable();
        $this->api($h, 'PUT', $this->lUrl($store, "/stock-counts/{$count}/lines/{$line}"), [])->assertUnprocessable()->assertJsonValidationErrors(['counted'], 'error.details');
        $this->setCounted($h, $store, $count, strtolower((string) Str::ulid()), 1)->assertNotFound();
    }

    /** QA D1 (P88C-12): short, extra and net values with a shortage and two extras (one from expected 0). */
    public function test_summary_values_with_short_and_extra(): void
    {
        [$s, $a, $b] = $this->countShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        [, $c] = $this->stocked($h, $store, stock: 0, variant: ['cost_amount' => 20000]);
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');
        $lines = $this->countLines($h, $store, $count);

        $this->setCounted($h, $store, $count, $lines[$a], 8)->assertOk()->assertJsonPath('data.line.value_amount', -80000);   // 10 → 8 at 40000
        $this->setCounted($h, $store, $count, $lines[$b], 7)->assertOk()->assertJsonPath('data.line.value_amount', 200000);   // 5 → 7 at 100000
        $this->setCounted($h, $store, $count, $lines[$c], 1)->assertOk()                                                       // 0 → 1 at 20000
            ->assertJsonPath('data.line.value_amount', 20000)
            ->assertJsonPath('data.summary', [
                'short_units' => 2, 'short_value_amount' => 80000, 'extra_units' => 3, 'extra_value_amount' => 220000,
                'not_counted' => 0, 'matched' => 0, 'differences' => 3, 'net_value_amount' => 140000,
            ])
            ->assertJsonPath('data.count.net_value_amount', 140000);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-counts'))->assertOk()->assertJsonPath('data.0.net_value_amount', 140000);

        $this->finishCount($h, $store, $count)->assertOk()
            ->assertJsonPath('data.net_value_amount', 140000)
            ->assertJsonPath('data.summary.extra_value_amount', 220000)
            ->assertJsonPath('data.summary.short_value_amount', 80000);
        $this->assertSame([8, 7, 1], [$this->onHand($tenant, $a, $s['main']), $this->onHand($tenant, $b, $s['main']), $this->onHand($tenant, $c, $s['main'])]);
        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'stock_count.finished')->value('meta'), true);
        $this->assertSame(140000, $meta['value_amount']);
    }

    #[Group('security')]
    public function test_values_only_with_costs_view(): void
    {
        [$s, $a] = $this->countShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');
        $line = $this->countLines($h, $store, $count)[$a];
        $this->setCounted($h, $store, $count, $line, 7)->assertOk()->assertJsonPath('data.line.value_amount', -120000);

        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF); // inventory.adjust, no costs.view
        $r = $this->setCounted($staff, $store, $count, $line, 6)->assertOk()
            ->assertJsonPath('data.line.value_amount', null)
            ->assertJsonPath('data.summary.short_units', 4)
            ->assertJsonPath('data.summary.short_value_amount', null)
            ->assertJsonPath('data.summary.extra_value_amount', null)
            ->assertJsonPath('data.summary.net_value_amount', null)
            ->assertJsonPath('data.count.net_value_amount', null);
        $this->assertNull($r->json('data.count.net_value_amount'));
        $this->api($staff, 'GET', $this->lUrl($store, "/stock-counts/{$count}"))->assertOk()->assertJsonPath('data.summary.net_value_amount', null);
        $this->api($staff, 'GET', $this->lUrl($store, '/stock-counts'))->assertOk()->assertJsonPath('data.0.net_value_amount', null);
        $this->api($staff, 'GET', $this->lUrl($store, "/stock-counts/{$count}/lines"))->assertOk()->assertJsonPath('data.0.value_amount', null);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-counts'))->assertOk()->assertJsonPath('data.0.net_value_amount', -160000);
        $this->api($h, 'GET', $this->lUrl($store, "/stock-counts/{$count}"))->assertOk()->assertJsonPath('data.summary.short_value_amount', 160000);

        // Finish audit carries the value only for a costs.view actor.
        $this->finishCount($staff, $store, $count)->assertOk()->assertJsonPath('data.net_value_amount', null);
        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'stock_count.finished')->value('meta'), true);
        $this->assertArrayNotHasKey('value_amount', $meta);
        $this->assertSame([['variant_id' => $a, 'delta' => -4]], $meta['deltas']);
        $this->api($h, 'GET', $this->lUrl($store, "/stock-counts/{$count}"))->assertOk()->assertJsonPath('data.net_value_amount', -160000);
    }

    public function test_lines_filters_order_and_list(): void
    {
        [$s, $a, $b] = $this->countShop();
        [$h, $store] = [$s['h'], $s['store']];
        $c = $this->createProduct($h, $store, $this->simpleProduct('Gift 100% cotton', 50000, ['status' => 'active'], ['initial_on_hand' => 2]))['variants'][0]['id'];
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');
        $lines = $this->countLines($h, $store, $count);
        $this->setCounted($h, $store, $count, $lines[$a], 10)->assertOk(); // matched
        $this->setCounted($h, $store, $count, $lines[$b], 1)->assertOk();  // difference

        $url = $this->lUrl($store, "/stock-counts/{$count}/lines");
        $all = $this->api($h, 'GET', $url)->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 3, 'not_counted' => 1, 'differences' => 1, 'matched' => 1])
            ->assertJsonPath('meta.per_page', 100)->json('data');
        $names = array_map(fn ($l) => mb_strtolower($l['variant']['product']['name']), $all);
        $sorted = $names;
        sort($sorted);
        $this->assertSame($sorted, $names);
        $this->api($h, 'GET', "{$url}?filter[state]=not_counted")->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.variant.id', $c)
            ->assertJsonPath('data.0.expected', null)->assertJsonPath('data.0.on_hand', 2);
        $this->api($h, 'GET', "{$url}?filter[state]=differences")->assertOk()->assertJsonPath('data.0.variant.id', $b)->assertJsonPath('data.0.difference', -4);
        $this->api($h, 'GET', "{$url}?filter[state]=matched")->assertOk()->assertJsonPath('data.0.variant.id', $a);
        $this->api($h, 'GET', "{$url}?q=890123")->assertOk()->assertJsonPath('meta.counts.all', 1)->assertJsonPath('data.0.variant.id', $b);
        $this->api($h, 'GET', "{$url}?q=pj-red")->assertOk()->assertJsonPath('data.0.variant.id', $a);
        $this->api($h, 'GET', "{$url}?q=%25")->assertOk()->assertJsonPath('meta.counts.all', 1)->assertJsonPath('data.0.variant.id', $c); // literal %
        $this->api($h, 'GET', "{$url}?filter[state]=bogus")->assertUnprocessable();
        $this->api($h, 'GET', "{$url}?q=".str_repeat('a', 121))->assertUnprocessable();

        $other = $this->startCount($h, $store, $s['shop'])->json('data.id');
        $this->finishCount($h, $store, $count)->assertOk();
        $this->api($h, 'GET', $this->lUrl($store, '/stock-counts'))->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 2, 'in_progress' => 1, 'completed' => 1, 'cancelled' => 0])
            ->assertJsonPath('data.0.id', $other);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-counts?filter[status]=completed'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $count);
        $this->api($h, 'GET', $this->lUrl($store, "/stock-counts?filter[location_id]={$s['shop']}"))->assertOk()->assertJsonPath('meta.total', 1);
    }

    #[Group('security')]
    public function test_finish_is_idempotent(): void
    {
        [$s, $a] = $this->countShop();
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $count = $this->startCount($h, $store, $s['main'])->json('data.id');
        $this->setCounted($h, $store, $count, $this->countLines($h, $store, $count)[$a], 4)->assertOk();

        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$count}/finish"), ['zero_uncounted' => false])->assertStatus(400);
        $key = (string) Str::uuid();
        $this->finishCount($h, $store, $count, false, $key)->assertOk();
        $this->finishCount($h, $store, $count, false, $key)->assertOk()->assertHeader('Idempotent-Replayed', 'true');
        $this->finishCount($h, $store, $count, true)->assertOk()->assertJsonPath('data.zero_uncounted', false); // repeat: unchanged
        $this->assertCount(1, $this->ledger($tenant, $a, 'count'));
        $this->assertSame(4, $this->onHand($tenant, $a, $s['main']));
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'stock_count.finished')->count());
    }

    #[Group('security')]
    public function test_isolation_permissions_plan_and_audit(): void
    {
        [$sa, $a] = $this->countShop('alpha');
        [$sb] = $this->countShop('beta');
        $countB = $this->startCount($sb['h'], $sb['store'], $sb['main'])->json('data.id');
        $lineB = array_values($this->countLines($sb['h'], $sb['store'], $countB))[0];
        $countA = $this->startCount($sa['h'], $sa['store'], $sa['main'])->json('data.id');

        $base = $this->lUrl($sa['store'], "/stock-counts/{$countB}");
        $this->assertTenantIsolation($sa['h'], [
            ['GET', $base], ['GET', "{$base}/lines"], ['POST', "{$base}/scan", ['code' => 'PJ-RED-M']], ['PUT', "{$base}/lines/{$lineB}", ['counted' => 1]],
            ['POST', "{$base}/cancel"],
        ]);
        $this->assertTenantIsolation($sa['h'] + ['Idempotency-Key' => (string) Str::uuid()], [['POST', "{$base}/finish", ['zero_uncounted' => false]]]);
        // B's line id under A's count → 404 too.
        $this->setCounted($sa['h'], $sa['store'], $countA, $lineB, 1)->assertNotFound();
        $this->startCount($sa['h'], $sa['store'], $sb['shop'])->assertUnprocessable()->assertJsonValidationErrors(['location_id'], 'error.details');
        $this->assertStoreIsolation(StockCount::class, $sa['tenant'], $sa['store'], $sb['store']);
        $this->assertStoreIsolation(StockCountItem::class, $sa['tenant'], $sa['store'], $sb['store']);

        // Permissions: reads for every member, writes need inventory.adjust.
        [, $viewer] = $this->memberWithRole($sa['tenant'], $this->customRole($sa['h'], 'Viewer', ['orders.view']));
        $this->api($viewer, 'GET', $this->lUrl($sa['store'], '/stock-counts'))->assertOk();
        $this->api($viewer, 'GET', $this->lUrl($sa['store'], "/stock-counts/{$countA}"))->assertOk();
        $this->api($viewer, 'GET', $this->lUrl($sa['store'], "/stock-counts/{$countA}/lines"))->assertOk();
        $this->startCount($viewer, $sa['store'], $sa['shop'])->assertForbidden();
        $this->scan($viewer, $sa['store'], $countA, 'PJ-RED-M')->assertForbidden();
        $this->finishCount($viewer, $sa['store'], $countA)->assertForbidden();
        $this->api($viewer, 'POST', $this->lUrl($sa['store'], "/stock-counts/{$countA}/cancel"))->assertForbidden();

        // No plan gate: a Free-plan store counts too.
        $this->planFor($sa['tenant'], Plan::FREE);
        $this->scan($sa['h'], $sa['store'], $countA, 'PJ-RED-M')->assertOk();
        $this->finishCount($sa['h'], $sa['store'], $countA)->assertOk();
        $c2 = $this->startCount($sa['h'], $sa['store'], $sa['main'])->assertCreated()->json('data.id');
        $this->api($sa['h'], 'POST', $this->lUrl($sa['store'], "/stock-counts/{$c2}/cancel"))->assertOk();
        $this->assertSame(1, $this->onHand($sa['tenant'], $a, $sa['main']));

        $owner = $this->platformQuery(TenantUser::class)->where('tenant_id', $sa['tenant']->id)->value('user_id');
        $rows = $this->platformTable('audit_logs')->where('tenant_id', $sa['tenant']->id)->where('action', 'like', 'stock_count.%')->get();
        foreach (['started', 'finished', 'cancelled'] as $what) {
            $row = $rows->firstWhere('action', "stock_count.{$what}");
            $this->assertNotNull($row, $what);
            $this->assertSame('stock_count', $row->subject_type);
            $this->assertSame($owner, $row->actor_id);
        }
        $finished = json_decode((string) $rows->firstWhere('action', 'stock_count.finished')->meta, true);
        $this->assertSame(false, $finished['zero_uncounted']);
        $this->assertSame(-9 * 40000, $finished['value_amount']);
    }
}
