<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Counts;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockCountItem;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Stock count lifecycle (PHASE-8-8C §8, P88C-11/12/18): start → count (scan +1 / set a quantity; each change stores
 * `expected` = the location's on_hand at that moment) → finish (ONE InventoryService::applyCount: delta = counted −
 * expected per counted line, so sales/receipts after a line was counted are kept; uncounted lines keep stock or go to
 * 0) or cancel. One open count per location (partial unique index → 409 `count_in_progress`). Every write locks the
 * count row first (§3.3), bumps `revision` (optional check → 409 `revision_conflict`) and the transitions are audited.
 * No plan gate (counts are structured adjustments, P88C-13).
 */
final class StockCountService
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /** @param array<string, mixed> $input validated StartStockCountInput */
    public function start(Store $store, array $input, User $user): StockCount
    {
        $location = Locations::resolve($store->id, (string) $input['location_id']);
        $category = null;
        if (($input['category_id'] ?? null) !== null) {
            $category = Category::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['category_id']))->first();
            if ($category === null) {
                throw ValidationException::withMessages(['category_id' => ['Unknown category.']]);
            }
        }
        $this->assertNoOpenCount($store, $location->id);

        $variants = $this->scope($store, $category);
        $total = (clone $variants)->count();
        if ($total > StockCount::MAX_LINES) {
            $max = StockCount::MAX_LINES;
            throw new ApiException(422, 'count_too_large', "A count can have at most {$max} products. Choose a category to count fewer.", ['lines' => $total, 'max' => $max]);
        }

        try {
            return DB::transaction(function () use ($store, $input, $user, $location, $category, $variants) {
                $count = new StockCount;
                $count->store_id = $store->id;
                $count->location_id = $location->id;
                $name = is_string($input['name'] ?? null) ? trim($input['name']) : '';
                $count->name = $name !== '' ? $name : self::defaultName($store, $location->name);
                $count->category_id = $category?->id;
                $count->status = StockCount::IN_PROGRESS;
                $count->started_by = $user->id;
                $count->started_at = now();
                $count->revision = 1;
                $count->save();

                $tenantId = $this->context->requireId();
                $n = 0;
                foreach ($variants->pluck('product_variants.id')->chunk(500) as $chunk) {
                    $rows = [];
                    foreach ($chunk as $variantId) {
                        $rows[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenantId, 'store_id' => $store->id, 'stock_count_id' => $count->id, 'variant_id' => $variantId];
                    }
                    StockCountItem::query()->insert($rows);
                    $n += count($rows);
                }
                $count->lines_count = $n;
                $count->save();
                $this->audit->log('stock_count.started', $count, [
                    'name' => $count->name, 'location_id' => $location->id, 'category_id' => $category?->id, 'lines_count' => $n,
                ]);

                return $count;
            });
        } catch (UniqueConstraintViolationException) {
            $this->assertNoOpenCount($store, $location->id); // the parallel winner's count

            throw new ApiException(409, 'count_in_progress', 'This location already has a count in progress.', ['count_id' => null]);
        }
    }

    /** Scan / type a SKU or barcode: +1 on the matching line (SKU first, then barcode; case-insensitive; literal). */
    public function scan(Store $store, StockCount $count, string $code, User $user): StockCountItem
    {
        return DB::transaction(function () use ($store, $count, $code, $user) {
            $row = $this->lock($store, $count, null, [StockCount::IN_PROGRESS]);
            $line = $this->match($row, $code);
            if ($line === null) {
                throw new ApiException(404, 'count_line_not_found', 'No product in this count has that SKU or barcode.', ['code' => $code]);
            }
            $next = min(StockCount::MAX_COUNTED, ($line->counted ?? 0) + 1);

            return $this->setCounted($store, $row, $line, $next, $user);
        });
    }

    public function setLine(Store $store, StockCount $count, string $lineId, ?int $counted, ?int $revision, User $user): StockCountItem
    {
        return DB::transaction(function () use ($store, $count, $lineId, $counted, $revision, $user) {
            $row = $this->lock($store, $count, $revision, [StockCount::IN_PROGRESS]);
            /** @var StockCountItem|null $line */
            $line = StockCountItem::query()->where('stock_count_id', $row->id)->whereKey(strtolower($lineId))->lockForUpdate()->first();
            if ($line === null) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }

            return $this->setCounted($store, $row, $line, $counted, $user);
        });
    }

    /**
     * Finish & adjust stock: one applyCount call (reason `count`). A repeat finish of a completed count returns it
     * unchanged (no new ledger rows); a cancelled count → 409.
     */
    public function finish(Store $store, StockCount $count, bool $zeroUncounted, ?int $revision, User $user, bool $costs): StockCount
    {
        return DB::transaction(function () use ($store, $count, $zeroUncounted, $revision, $user, $costs) {
            $row = $this->lock($store, $count, null, [StockCount::IN_PROGRESS, StockCount::COMPLETED]);
            if ($row->status === StockCount::COMPLETED) {
                return $row;
            }
            $this->assertRevision($row, $revision);

            $items = StockCountItem::query()->where('stock_count_id', $row->id)->get(['id', 'variant_id', 'counted', 'expected']);
            $lines = [];
            foreach ($items as $item) {
                if ($item->counted !== null) {
                    $delta = $item->counted - (int) $item->expected;
                    if ($delta !== 0) {
                        $lines[] = ['variant_id' => $item->variant_id, 'delta' => $delta];
                    }
                } elseif ($zeroUncounted) {
                    $lines[] = ['variant_id' => $item->variant_id, 'zero' => true];
                }
            }
            $applied = $this->inventory->applyCount($store->id, $row->location_id, $lines, $row->id, $row->name, $user->id);

            $byVariant = $items->keyBy('variant_id');
            foreach ($applied as $variantId => $delta) {
                StockCountItem::query()->whereKey($byVariant[$variantId]->id)->update(['applied_delta' => $delta]);
            }

            $row->status = StockCount::COMPLETED;
            $row->zero_uncounted = $zeroUncounted;
            $row->finished_by = $user->id;
            $row->finished_at = now();
            $row->revision++;
            $row->save();

            $deltas = [];
            foreach ($applied as $variantId => $delta) {
                $deltas[] = ['variant_id' => $variantId, 'delta' => $delta];
            }
            $meta = [
                'name' => $row->name,
                'location_id' => $row->location_id,
                'zero_uncounted' => $zeroUncounted,
                'lines_count' => $row->lines_count,
                'counted_count' => $row->counted_count,
                'lines_adjusted' => count($applied),
                'units_added' => array_sum(array_filter($applied, fn (int $d) => $d > 0)),
                'units_removed' => -array_sum(array_filter($applied, fn (int $d) => $d < 0)),
                'deltas' => array_slice($deltas, 0, 200),
            ];
            if ($costs) {
                $meta['value_amount'] = StockCountPresenter::appliedValue($row);
            }
            $this->audit->log('stock_count.finished', $row, $meta);

            return $row;
        });
    }

    public function cancel(Store $store, StockCount $count, ?int $revision, User $user): StockCount
    {
        return DB::transaction(function () use ($store, $count, $revision, $user) {
            $row = $this->lock($store, $count, $revision, [StockCount::IN_PROGRESS]);
            $row->status = StockCount::CANCELLED;
            $row->cancelled_at = now();
            $row->cancelled_by = $user->id;
            $row->revision++;
            $row->save();
            $this->audit->log('stock_count.cancelled', $row, ['name' => $row->name, 'location_id' => $row->location_id, 'counted_count' => $row->counted_count]);

            return $row;
        });
    }

    /** @param list<string> $statuses */
    public function lock(Store $store, StockCount $count, ?int $revision, array $statuses): StockCount
    {
        /** @var StockCount $row */
        $row = StockCount::query()->where('store_id', $store->id)->whereKey($count->id)->lockForUpdate()->firstOrFail();
        if (! in_array($row->status, $statuses, true)) {
            throw new ApiException(409, 'invalid_state_transition', 'This count is no longer in progress.');
        }
        $this->assertRevision($row, $revision);

        return $row;
    }

    private function assertRevision(StockCount $row, ?int $revision): void
    {
        if ($revision !== null && $revision !== $row->revision) {
            throw new ApiException(409, 'revision_conflict', 'This count changed since you opened it. Reload and try again.', ['revision' => $row->revision]);
        }
    }

    /** Stores counted + expected (the location's on_hand NOW) + who/when; null un-counts. Bumps the count's revision. */
    private function setCounted(Store $store, StockCount $row, StockCountItem $line, ?int $counted, User $user): StockCountItem
    {
        $wasCounted = $line->counted !== null;
        if ($counted === null) {
            $line->counted = null;
            $line->expected = null;
            $line->counted_at = null;
            $line->counted_by = null;
        } else {
            $line->counted = $counted;
            $line->expected = (int) (Inventory::query()->where('store_id', $store->id)->where('location_id', $row->location_id)
                ->where('variant_id', $line->variant_id)->value('on_hand') ?? 0);
            $line->counted_at = now();
            $line->counted_by = $user->id;
        }
        $line->save();
        $row->counted_count += ($counted !== null ? 1 : 0) - ($wasCounted ? 1 : 0);
        $row->revision++;
        $row->save();

        return $line;
    }

    private function match(StockCount $count, string $code): ?StockCountItem
    {
        $code = mb_strtolower($code);
        foreach (['sku', 'barcode'] as $column) {
            // Equality on lower(): `%` and `_` are plain characters here (S193); only this count's lines.
            /** @var StockCountItem|null $line */
            $line = StockCountItem::query()->where('stock_count_items.stock_count_id', $count->id)
                ->join('product_variants', 'product_variants.id', '=', 'stock_count_items.variant_id')
                ->whereRaw("lower(product_variants.{$column}) = ?", [$code])
                ->orderBy('stock_count_items.id')->select('stock_count_items.*')->first();
            if ($line !== null) {
                return $line;
            }
        }

        return null;
    }

    /** Tracked, non-deleted variants of active products (in the category and its sub-categories). */
    private function scope(Store $store, ?Category $category): Builder
    {
        $query = DB::table('product_variants')
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->where('product_variants.tenant_id', $store->tenant_id)
            ->where('product_variants.store_id', $store->id)
            ->where('product_variants.track_inventory', true)
            ->whereNull('product_variants.deleted_at')
            ->whereNull('products.deleted_at')
            ->where('products.status', Product::ACTIVE)
            ->orderBy('product_variants.id');
        if ($category !== null) {
            $ids = $this->withDescendants($store, $category->id);
            $query->whereExists(fn ($q) => $q->selectRaw('1')->from('product_categories')
                ->whereColumn('product_categories.product_id', 'products.id')
                ->where('product_categories.tenant_id', $store->tenant_id)
                ->whereIn('product_categories.category_id', $ids));
        }

        return $query;
    }

    /** @return list<string> */
    private function withDescendants(Store $store, string $id): array
    {
        $all = [$id];
        $frontier = [$id];
        for ($depth = 0; $depth < 5 && $frontier !== []; $depth++) {
            $frontier = Category::query()->where('store_id', $store->id)->whereIn('parent_id', $frontier)->pluck('id')->all();
            $all = array_merge($all, $frontier);
        }

        return array_values(array_unique($all));
    }

    private function assertNoOpenCount(Store $store, string $locationId): void
    {
        $open = StockCount::query()->where('store_id', $store->id)->where('location_id', $locationId)->where('status', StockCount::IN_PROGRESS)->value('id');
        if ($open !== null) {
            throw new ApiException(409, 'count_in_progress', 'This location already has a count in progress. Finish or cancel it first.', ['count_id' => $open]);
        }
    }

    /** "Count 25 Nov · Main warehouse" (store timezone). */
    public static function defaultName(Store $store, string $location): string
    {
        return mb_substr('Count '.CarbonImmutable::now($store->timezone ?: 'Asia/Dhaka')->format('j M').' · '.$location, 0, 80);
    }
}
