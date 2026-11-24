<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Counts;

use App\Domain\Inventory\Http\Resources\StockVariantPresenter;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockCountItem;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection as EloquentCollection;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * `StockCount`, `StockCountDetail`, `StockCountSummary`, `StockCountLine` payloads (@storeplix/types, PHASE-8-8C §8).
 * Every `*_amount` is difference × the variant's current `cost_amount` (missing cost = 0) and null without `costs.view`
 * (P88C-12, S191).
 */
final class StockCountPresenter
{
    public const LINES_PER_PAGE = 100;

    /**
     * @param  Collection<int, StockCount>  $counts
     * @return list<array<string, mixed>>
     */
    public static function many(Store $store, Collection $counts, bool $costs): array
    {
        $counts->loadMissing(['location', 'category', 'startedBy', 'finishedBy']);
        $net = $costs ? self::netValues($counts->all()) : [];

        return $counts->map(fn (StockCount $c) => self::one($store, $c, $costs, $net[$c->id] ?? 0))->values()->all();
    }

    /** @return array<string, mixed> StockCount */
    public static function one(Store $store, StockCount $c, bool $costs, ?int $net = null): array
    {
        if ($costs && $net === null) {
            $net = self::netValues([$c])[$c->id] ?? 0;
        }

        return [
            'id' => $c->id,
            'name' => $c->name,
            'location' => ['id' => $c->location_id, 'name' => (string) $c->location?->name],
            'category' => $c->category === null ? null : ['id' => $c->category->id, 'name' => $c->category->name],
            'status' => $c->status,
            'lines_count' => $c->lines_count,
            'counted_count' => $c->counted_count,
            'currency' => $store->currency ?: 'BDT',
            'net_value_amount' => $costs ? (int) $net : null,
            'zero_uncounted' => $c->zero_uncounted,
            'started_by' => UserRef::of($c->startedBy),
            'started_at' => UserRef::iso($c->started_at),
            'finished_by' => UserRef::of($c->finishedBy),
            'finished_at' => UserRef::iso($c->finished_at),
            'cancelled_at' => UserRef::iso($c->cancelled_at),
            'revision' => $c->revision,
        ];
    }

    /** @return array<string, mixed> StockCountDetail */
    public static function detail(Store $store, StockCount $c, bool $costs): array
    {
        $c->load(['location', 'category', 'startedBy', 'finishedBy']);
        $summary = self::summary($c, $costs);

        return self::one($store, $c, $costs, $c->status === StockCount::COMPLETED ? null : ($summary['net_value_amount'] ?? 0)) + ['summary' => $summary];
    }

    /** @return array<string, mixed> StockCountSummary ("If you finish now"; counted lines, difference = counted − expected) */
    public static function summary(StockCount $c, bool $costs): array
    {
        $cost = 'coalesce(product_variants.cost_amount, 0)';
        $diff = '(stock_count_items.counted - stock_count_items.expected)';
        $s = DB::table('stock_count_items')
            ->join('product_variants', 'product_variants.id', '=', 'stock_count_items.variant_id')
            ->where('stock_count_items.tenant_id', $c->tenant_id)
            ->where('stock_count_items.stock_count_id', $c->id)
            ->selectRaw(implode(', ', [
                'coalesce(sum(CASE WHEN stock_count_items.counted IS NULL THEN 1 ELSE 0 END), 0) as not_counted',
                "coalesce(sum(CASE WHEN stock_count_items.counted IS NOT NULL AND {$diff} = 0 THEN 1 ELSE 0 END), 0) as matched",
                "coalesce(sum(CASE WHEN stock_count_items.counted IS NOT NULL AND {$diff} <> 0 THEN 1 ELSE 0 END), 0) as differences",
                "coalesce(sum(CASE WHEN {$diff} < 0 THEN -({$diff}) ELSE 0 END), 0) as short_units",
                "coalesce(sum(CASE WHEN {$diff} > 0 THEN {$diff} ELSE 0 END), 0) as extra_units",
                "coalesce(sum(CASE WHEN {$diff} < 0 THEN -({$diff}) * {$cost} ELSE 0 END), 0) as short_value",
                "coalesce(sum(CASE WHEN {$diff} > 0 THEN {$diff} * {$cost} ELSE 0 END), 0) as extra_value",
            ]))->first();
        $short = (int) ($s->short_value ?? 0);
        $extra = (int) ($s->extra_value ?? 0);

        return [
            'short_units' => (int) ($s->short_units ?? 0),
            'short_value_amount' => $costs ? $short : null,
            'extra_units' => (int) ($s->extra_units ?? 0),
            'extra_value_amount' => $costs ? $extra : null,
            'not_counted' => (int) ($s->not_counted ?? 0),
            'matched' => (int) ($s->matched ?? 0),
            'differences' => (int) ($s->differences ?? 0),
            'net_value_amount' => $costs ? $extra - $short : null,
        ];
    }

    /** Σ applied_delta × cost of a completed count (audit value). */
    public static function appliedValue(StockCount $c): int
    {
        return (int) DB::table('stock_count_items')
            ->join('product_variants', 'product_variants.id', '=', 'stock_count_items.variant_id')
            ->where('stock_count_items.tenant_id', $c->tenant_id)
            ->where('stock_count_items.stock_count_id', $c->id)
            ->selectRaw('coalesce(sum(coalesce(stock_count_items.applied_delta, 0) * coalesce(product_variants.cost_amount, 0)), 0) as v')
            ->value('v');
    }

    /**
     * Net value per count: completed → what was applied; otherwise → counted − expected of counted lines.
     *
     * @param  list<StockCount>  $counts
     * @return array<string, int>
     */
    private static function netValues(array $counts): array
    {
        if ($counts === []) {
            return [];
        }
        $completed = [];
        foreach ($counts as $c) {
            $completed[$c->id] = $c->status === StockCount::COMPLETED;
        }
        $rows = DB::table('stock_count_items')
            ->join('product_variants', 'product_variants.id', '=', 'stock_count_items.variant_id')
            ->where('stock_count_items.tenant_id', $counts[0]->tenant_id)
            ->whereIn('stock_count_items.stock_count_id', array_keys($completed))
            ->groupBy('stock_count_items.stock_count_id')
            ->selectRaw(implode(', ', [
                'stock_count_items.stock_count_id as id',
                'coalesce(sum(coalesce(stock_count_items.applied_delta, 0) * coalesce(product_variants.cost_amount, 0)), 0) as applied',
                'coalesce(sum(CASE WHEN stock_count_items.counted IS NOT NULL THEN (stock_count_items.counted - stock_count_items.expected) * coalesce(product_variants.cost_amount, 0) ELSE 0 END), 0) as preview',
            ]))->get();
        $out = [];
        foreach ($rows as $r) {
            $out[$r->id] = (int) ($completed[$r->id] ? $r->applied : $r->preview);
        }

        return $out;
    }

    /**
     * The paged line list (`GET …/{count}/lines`): ordered by product name, then variant; `filter[state]`, `q` (name,
     * SKU or barcode; literal, case-insensitive); `meta.counts` per state (+ all) under `q`.
     *
     * @return array{data: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public static function lines(StockCount $c, ?string $state, ?string $q, int $perPage, bool $costs): array
    {
        $base = StockCountItem::query()->where('stock_count_items.stock_count_id', $c->id)
            ->join('product_variants', 'product_variants.id', '=', 'stock_count_items.variant_id')
            ->leftJoin('products', 'products.id', '=', 'product_variants.product_id');
        $q = trim((string) $q);
        if ($q !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $base->where(fn ($w) => $w->whereRaw("lower(products.name) like ? escape '\\'", [$like])
                ->orWhereRaw("lower(product_variants.sku) like ? escape '\\'", [$like])
                ->orWhereRaw("lower(product_variants.barcode) like ? escape '\\'", [$like]));
        }
        $counts = (clone $base)->toBase()->selectRaw(implode(', ', [
            'count(*) as all_lines',
            'coalesce(sum(CASE WHEN stock_count_items.counted IS NULL THEN 1 ELSE 0 END), 0) as not_counted',
            'coalesce(sum(CASE WHEN stock_count_items.counted IS NOT NULL AND stock_count_items.counted <> stock_count_items.expected THEN 1 ELSE 0 END), 0) as differences',
            'coalesce(sum(CASE WHEN stock_count_items.counted IS NOT NULL AND stock_count_items.counted = stock_count_items.expected THEN 1 ELSE 0 END), 0) as matched',
        ]))->first();

        $page = (clone $base)
            ->when($state !== null, fn (Builder $w) => self::state($w, (string) $state))
            ->select('stock_count_items.*')
            ->orderByRaw('lower(products.name)')->orderBy('product_variants.position')->orderBy('stock_count_items.id')
            ->with(StockVariantPresenter::paths())
            ->paginate($perPage);

        return [
            'data' => self::presentLines($c, $page, $costs),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => [
                    'all' => (int) ($counts->all_lines ?? 0),
                    'not_counted' => (int) ($counts->not_counted ?? 0),
                    'differences' => (int) ($counts->differences ?? 0),
                    'matched' => (int) ($counts->matched ?? 0),
                ],
            ],
        ];
    }

    /** @return array<string, mixed> StockCountLine */
    public static function line(StockCount $c, StockCountItem $line, bool $costs): array
    {
        $line->load(array_merge(StockVariantPresenter::paths(), ['countedBy']));

        return self::presentLines($c, [$line], $costs)[0];
    }

    /** @param Builder<StockCountItem> $query */
    private static function state(Builder $query, string $state): void
    {
        match ($state) {
            'not_counted' => $query->whereNull('stock_count_items.counted'),
            'differences' => $query->whereNotNull('stock_count_items.counted')->whereColumn('stock_count_items.counted', '<>', 'stock_count_items.expected'),
            default => $query->whereNotNull('stock_count_items.counted')->whereColumn('stock_count_items.counted', '=', 'stock_count_items.expected'),
        };
    }

    /**
     * @param  iterable<StockCountItem>|LengthAwarePaginator<int, StockCountItem>  $lines
     * @return list<array<string, mixed>>
     */
    private static function presentLines(StockCount $c, iterable $lines, bool $costs): array
    {
        $items = new EloquentCollection($lines instanceof LengthAwarePaginator ? $lines->items() : iterator_to_array($lines, false));
        $items->loadMissing('countedBy');
        $onHand = Inventory::query()->where('store_id', $c->store_id)->where('location_id', $c->location_id)
            ->whereIn('variant_id', $items->pluck('variant_id')->all())->pluck('on_hand', 'variant_id');

        return $items->map(function (StockCountItem $i) use ($onHand, $costs) {
            $difference = $i->counted === null ? null : $i->counted - (int) $i->expected;
            $cost = (int) ($i->variant?->cost_amount ?? 0);

            return [
                'id' => $i->id,
                'variant' => StockVariantPresenter::ref($i->variant, $i->variant_id),
                'counted' => $i->counted,
                'expected' => $i->counted === null ? null : $i->expected,
                'difference' => $difference,
                'on_hand' => (int) ($onHand[$i->variant_id] ?? 0),
                'value_amount' => $costs && $difference !== null ? $difference * $cost : null,
                'counted_at' => UserRef::iso($i->counted_at),
                'counted_by' => UserRef::of($i->countedBy),
                'applied_delta' => $i->applied_delta,
            ];
        })->values()->all();
    }
}
