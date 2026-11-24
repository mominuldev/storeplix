<?php

namespace App\Domain\Inventory\Http\Controllers;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Inventory\Http\Resources\InventoryPresenter;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\InventorySql;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Inventory\Models\Location;
use App\Domain\Purchasing\PurchaseHistory;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * §3.3 inventory. Stock changes only through InventoryService (P4-12).
 *
 * PHASE-8-8C §5.4: `filter[location_id]` omitted = "All locations" (TOTAL reader: Σ over non-archived locations, one
 * row per variant with `locations[]`); with a location = that location's row (LOCATION reader; missing row = 0).
 * Adjust items and the threshold PATCH take an optional `location_id` (default location). Another store's location →
 * 422 validation_failed; an archived one → 422 `location_archived`.
 */
class InventoryController
{
    /** Request attribute set by the external API: no location filter → online numbers on top (PHASE-8-8C §5.4). */
    public const ONLINE_TOP = 'inventory.online_top';

    public function __construct(
        private readonly InventoryService $inventory,
        private readonly TenantContext $context,
    ) {}

    /** GET /stores/{store}/inventory */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:stock,category_id,product_id,location_id'],
            'filter.stock' => ['sometimes', 'string', 'regex:/^(in|low|out|untracked)(,(in|low|out|untracked))*$/'],
            'filter.category_id' => ['sometimes', 'string', 'size:26'],
            'filter.product_id' => ['sometimes', 'string', 'size:26'],
            'filter.location_id' => ['sometimes', 'string', 'size:26'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:name,available,-available,-updated_at'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);

        $filter = $input['filter'] ?? [];
        $location = isset($filter['location_id']) ? Locations::resolve($store->id, $filter['location_id'], 'filter.location_id') : null;
        $query = $this->base($store, $location)->select('product_variants.*');
        if (isset($filter['stock'])) {
            $statuses = explode(',', $filter['stock']);
            $query->where(function (Builder $w) use ($statuses) {
                foreach ($statuses as $status) {
                    $w->orWhereRaw('('.StockSql::condition($status).')');
                }
            });
        }
        if (isset($filter['product_id'])) {
            $query->where('product_variants.product_id', strtolower($filter['product_id']));
        }
        if (isset($filter['category_id'])) {
            $query->whereExists(fn ($sub) => $sub->select(DB::raw(1))->from('product_categories')
                ->whereColumn('product_categories.product_id', 'product_variants.product_id')
                ->where('product_categories.category_id', strtolower($filter['category_id'])));
        }
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $like = StockSql::contains($q);
            $op = StockSql::like();
            $query->where(fn ($w) => $w->where('products.name', $op, $like)
                ->orWhere('product_variants.sku', $op, $like)->orWhere('product_variants.barcode', $op, $like));
        }
        $available = StockSql::available();
        match ($input['sort'] ?? 'name') {
            'available' => $query->orderByRaw("{$available} asc")->orderBy('product_variants.id'),
            '-available' => $query->orderByRaw("{$available} desc")->orderBy('product_variants.id'),
            '-updated_at' => $query->orderByDesc('inventories.updated_at')->orderByDesc('product_variants.id'),
            default => $query->orderBy('products.name')->orderBy('products.id')->orderBy('product_variants.position'),
        };

        $paginator = $query->with(['inventories', 'product.images.media'])->paginate((int) ($input['per_page'] ?? 25));
        $costs = $this->costs();
        $locations = Locations::active($store->id);
        $mode = $location?->id ?? ($request->attributes->get(self::ONLINE_TOP) === true ? InventoryPresenter::ONLINE : null);
        // PHASE-8-8B §8.1; with a location, only POs receiving there (PHASE-8-8C §5.4).
        $incoming = PurchaseHistory::incoming($store, $paginator->getCollection()->pluck('id')->all(), $location?->id);

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (ProductVariant $v) => InventoryPresenter::item($v, $costs, $mode, $locations) + ['incoming' => $incoming[$v->id] ?? 0])->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
                'summary' => $this->summary($store, $costs, $location),
            ],
        ]);
    }

    /** PATCH /stores/{store}/inventory/{variant} — low-stock threshold of one location's row (default location). */
    public function update(Request $request, Store $store, ProductVariant $variant): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'low_stock_threshold' => ['present', 'nullable', 'integer:strict', 'min:0', 'max:100000'],
            'location_id' => ['sometimes', 'nullable', 'string', 'size:26'],
        ]);
        abort_if($variant->product === null || $variant->product->trashed(), 404);
        $location = Locations::resolve($store->id, $input['location_id'] ?? null);

        DB::transaction(function () use ($store, $variant, $location, $input) {
            $updated = Inventory::query()->where('store_id', $store->id)->where('variant_id', $variant->id)->where('location_id', $location->id)
                ->update(['low_stock_threshold' => $input['low_stock_threshold'], 'updated_at' => now()]);
            if ($updated === 0) {
                // No stock row there yet: a threshold-only row (on_hand 0; not a stock change, no ledger row).
                $row = new Inventory(['low_stock_threshold' => $input['low_stock_threshold']]);
                $row->store_id = $store->id;
                $row->variant_id = $variant->id;
                $row->location_id = $location->id;
                $row->save();
            }
        });

        return new JsonResponse(['data' => $this->item($store, $variant->id, isset($input['location_id']) ? $location->id : null)]);
    }

    /** POST /stores/{store}/inventory/adjustments */
    public function adjust(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'reason' => ['required', 'string', Rule::in(InventoryMovement::MANUAL_REASONS)],
            'note' => ['nullable', 'string', 'max:255', 'required_if:reason,other', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'items' => ['required', 'array', 'min:1', 'max:100'],
            'items.*' => ['array'],
            'items.*.variant_id' => ['required', 'string', Rule::exists('product_variants', 'id')
                ->where('tenant_id', $this->context->requireId())->where('store_id', $store->id)->whereNull('deleted_at')],
            'items.*.mode' => ['required', 'string', 'in:delta,set'],
            'items.*.quantity' => ['required', 'integer:strict', 'min:-1000000', 'max:1000000'],
            'items.*.expected_on_hand' => ['sometimes', 'nullable', 'integer:strict'],
            'items.*.location_id' => ['sometimes', 'nullable', 'string', 'size:26'],
        ], ['items.*.variant_id.exists' => 'Unknown variant.']);

        $errors = [];
        $seen = [];
        $locations = [];
        foreach ($input['items'] as $i => $item) {
            if ($item['mode'] === 'delta' && $item['quantity'] === 0) {
                $errors["items.{$i}.quantity"] = ['Enter a change other than 0.'];
            }
            if ($item['mode'] === 'set' && $item['quantity'] < 0) {
                $errors["items.{$i}.quantity"] = ["Stock can't be negative."];
            }
            $locationId = isset($item['location_id']) ? strtolower((string) $item['location_id']) : null;
            $pair = strtolower($item['variant_id']).'|'.($locationId ?? '');
            if (isset($seen[$pair])) {
                $errors["items.{$i}.variant_id"] = ['This variant is listed twice.'];
            }
            $seen[$pair] = true;
            if ($locationId !== null && ! isset($locations[$locationId])) {
                $locations[$locationId] = Location::query()->where('store_id', $store->id)->whereKey($locationId)->first();
                if ($locations[$locationId] === null) {
                    $errors["items.{$i}.location_id"] = ['Unknown location.'];
                }
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
        foreach ($input['items'] as $i => $item) {
            if (isset($item['location_id'])) {
                Locations::resolve($store->id, $item['location_id'], "items.{$i}.location_id"); // archived → 422 location_archived
            }
        }
        // Rows without a location go to the default; two items for the same variant must not name the same row twice.
        $default = Locations::defaultId($store->id);
        $rowSeen = [];
        foreach ($input['items'] as $i => $item) {
            $pair = strtolower($item['variant_id']).'|'.(isset($item['location_id']) ? strtolower((string) $item['location_id']) : $default);
            if (isset($rowSeen[$pair])) {
                throw ValidationException::withMessages(["items.{$i}.variant_id" => ['This variant is listed twice.']]);
            }
            $rowSeen[$pair] = true;
        }

        $items = array_map(fn ($item) => ['variant_id' => strtolower($item['variant_id']), 'location_id' => isset($item['location_id']) ? strtolower((string) $item['location_id']) : null] + $item, array_values($input['items']));
        $result = $this->inventory->adjust($store->id, $input['reason'], $input['note'] ?? null, $items, $request->user()?->getKey());

        $variants = $this->variants(array_values(array_unique(array_column($items, 'variant_id'))));
        $costs = $this->costs();
        $active = Locations::active($store->id);
        $incoming = PurchaseHistory::incoming($store, array_values(array_unique(array_column($items, 'variant_id'))));
        $movements = (new Collection($result['movements']))->load(['variant.product', 'actor']);
        $names = Locations::names($store->id);

        return new JsonResponse(['data' => [
            'items' => array_values(array_map(fn ($item) => InventoryPresenter::item($variants[$item['variant_id']], $costs, $item['location_id'], $active) + ['incoming' => $incoming[$item['variant_id']] ?? 0], $items)),
            'movements' => $movements->map(fn (InventoryMovement $m) => InventoryPresenter::movement($m, $names))->values()->all(),
        ]]);
    }

    /** GET /stores/{store}/inventory/movements */
    public function movements(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:variant_id,product_id,reason,reference_type,created_at,location_id'],
            'filter.reference_type' => ['sometimes', 'string', Rule::in(InventoryMovement::REFERENCE_TYPES)], // PHASE-8-8B §8.1
            'filter.variant_id' => ['sometimes', 'string', 'size:26'],
            'filter.product_id' => ['sometimes', 'string', 'size:26'],
            'filter.location_id' => ['sometimes', 'string', 'size:26'],
            'filter.reason' => ['sometimes', 'string', 'regex:/^('.implode('|', InventoryMovement::REASONS).')(,('.implode('|', InventoryMovement::REASONS).'))*$/'],
            'filter.created_at' => ['sometimes', 'array:gte,lte'],
            'filter.created_at.gte' => ['sometimes', 'date'],
            'filter.created_at.lte' => ['sometimes', 'date'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = $input['filter'] ?? [];
        // The ledger of an archived location stays readable.
        $location = isset($filter['location_id']) ? Locations::resolve($store->id, $filter['location_id'], 'filter.location_id', allowArchived: true) : null;

        $paginator = InventoryMovement::query()->where('inventory_movements.store_id', $store->id)
            ->when($location !== null, fn ($q) => $q->where('location_id', $location->id))
            ->when(isset($filter['variant_id']), fn ($q) => $q->where('variant_id', strtolower($filter['variant_id'])))
            ->when(isset($filter['product_id']), fn ($q) => $q->whereIn('variant_id', ProductVariant::withTrashed()
                ->where('store_id', $store->id)->where('product_id', strtolower($filter['product_id']))->select('id')))
            ->when(isset($filter['reason']), fn ($q) => $q->whereIn('reason', explode(',', $filter['reason'])))
            ->when(isset($filter['reference_type']), fn ($q) => $q->where('reference_type', $filter['reference_type']))
            ->when(isset($filter['created_at']['gte']), fn ($q) => $q->where('created_at', '>=', Carbon::parse($filter['created_at']['gte'])))
            ->when(isset($filter['created_at']['lte']), fn ($q) => $q->where('created_at', '<=', Carbon::parse($filter['created_at']['lte'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->with(['variant.product', 'actor'])
            ->paginate((int) ($input['per_page'] ?? 25));
        $names = Locations::names($store->id);

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (InventoryMovement $m) => InventoryPresenter::movement($m, $names))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    /**
     * Non-deleted variants of non-deleted products of the store, joined (as "inventories") with their totals over
     * non-archived locations, or with one location's row.
     */
    private function base(Store $store, ?Location $location): Builder
    {
        $query = ProductVariant::query()
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->where('product_variants.store_id', $store->id)
            ->whereNull('products.deleted_at');

        return $location === null ? InventorySql::joinTotals($query, $store->id) : InventorySql::joinLocation($query, $location->id);
    }

    /** @return array<string, mixed> InventorySummary over the whole store (or the filtered location) */
    private function summary(Store $store, bool $costs, ?Location $location): array
    {
        $onHand = 'CASE WHEN inventories.on_hand > 0 THEN inventories.on_hand ELSE 0 END';
        $row = $this->base($store, $location)->toBase()->selectRaw(implode(', ', [
            'count(*) as variants_count',
            'count(distinct product_variants.product_id) as products_count',
            "coalesce(sum({$onHand}), 0) as units_on_hand",
            'coalesce(sum(inventories.committed), 0) as committed_units',
            "coalesce(sum({$onHand} * product_variants.price_amount), 0) as value_price",
            "coalesce(sum(CASE WHEN product_variants.cost_amount IS NOT NULL THEN {$onHand} * product_variants.cost_amount ELSE 0 END), 0) as value_cost",
            'coalesce(sum(CASE WHEN '.StockSql::condition('low').' THEN 1 ELSE 0 END), 0) as low_count',
            'coalesce(sum(CASE WHEN '.StockSql::condition('out').' THEN 1 ELSE 0 END), 0) as out_count',
        ]))->first();

        return [
            'currency' => $store->currency ?: 'BDT',
            'stock_value_cost_amount' => $costs ? (int) $row->value_cost : null,
            'stock_value_price_amount' => (int) $row->value_price,
            'units_on_hand' => (int) $row->units_on_hand,
            'committed_units' => (int) $row->committed_units,
            'low_stock_variants' => (int) $row->low_count,
            'out_of_stock_variants' => (int) $row->out_count,
            'variants_count' => (int) $row->variants_count,
            'products_count' => (int) $row->products_count,
        ];
    }

    /** @param list<string> $ids @return array<string, ProductVariant> */
    private function variants(array $ids): array
    {
        return ProductVariant::query()->whereIn('id', $ids)->with(['inventories', 'product.images.media'])->get()->keyBy('id')->all();
    }

    /** @return array<string, mixed> */
    private function item(Store $store, string $variantId, ?string $locationId = null): array
    {
        return InventoryPresenter::item($this->variants([$variantId])[$variantId], $this->costs(), $locationId)
            + ['incoming' => PurchaseHistory::incoming($store, [$variantId])[$variantId] ?? 0];
    }

    private function costs(): bool
    {
        return $this->context->allows(Permission::CostsView);
    }
}
