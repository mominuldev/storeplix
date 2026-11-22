<?php

namespace App\Domain\Inventory\Http\Controllers;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Inventory\Http\Resources\InventoryPresenter;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
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

/** §3.3 inventory. Stock changes only through InventoryService (P4-12). */
class InventoryController
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly TenantContext $context,
    ) {}

    /** GET /stores/{store}/inventory */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:stock,category_id,product_id'],
            'filter.stock' => ['sometimes', 'string', 'regex:/^(in|low|out|untracked)(,(in|low|out|untracked))*$/'],
            'filter.category_id' => ['sometimes', 'string', 'size:26'],
            'filter.product_id' => ['sometimes', 'string', 'size:26'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:name,available,-available,-updated_at'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);

        $query = $this->base($store)->select('product_variants.*');
        $filter = $input['filter'] ?? [];
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

        $paginator = $query->with(['inventory', 'product.images.media'])->paginate((int) ($input['per_page'] ?? 25));
        $costs = $this->costs();

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (ProductVariant $v) => InventoryPresenter::item($v, $costs))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
                'summary' => $this->summary($store, $costs),
            ],
        ]);
    }

    /** PATCH /stores/{store}/inventory/{variant} — low-stock threshold only. */
    public function update(Request $request, Store $store, ProductVariant $variant): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['low_stock_threshold' => ['present', 'nullable', 'integer:strict', 'min:0', 'max:100000']]);
        abort_if($variant->product === null || $variant->product->trashed(), 404);

        Inventory::query()->where('variant_id', $variant->id)->update(['low_stock_threshold' => $input['low_stock_threshold'], 'updated_at' => now()]);

        return new JsonResponse(['data' => $this->item($variant->id)]);
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
            'items.*.variant_id' => ['required', 'string', 'distinct', Rule::exists('product_variants', 'id')
                ->where('tenant_id', $this->context->requireId())->where('store_id', $store->id)->whereNull('deleted_at')],
            'items.*.mode' => ['required', 'string', 'in:delta,set'],
            'items.*.quantity' => ['required', 'integer:strict', 'min:-1000000', 'max:1000000'],
            'items.*.expected_on_hand' => ['sometimes', 'nullable', 'integer:strict'],
        ], ['items.*.variant_id.exists' => 'Unknown variant.', 'items.*.variant_id.distinct' => 'This variant is listed twice.']);

        $errors = [];
        foreach ($input['items'] as $i => $item) {
            if ($item['mode'] === 'delta' && $item['quantity'] === 0) {
                $errors["items.{$i}.quantity"] = ['Enter a change other than 0.'];
            }
            if ($item['mode'] === 'set' && $item['quantity'] < 0) {
                $errors["items.{$i}.quantity"] = ["Stock can't be negative."];
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        $items = array_map(fn ($item) => ['variant_id' => strtolower($item['variant_id'])] + $item, array_values($input['items']));
        $result = $this->inventory->adjust($store->id, $input['reason'], $input['note'] ?? null, $items, $request->user()?->getKey());

        $variants = $this->variants(array_column($items, 'variant_id'));
        $costs = $this->costs();
        $movements = (new Collection($result['movements']))->load(['variant.product', 'actor']);

        return new JsonResponse(['data' => [
            'items' => array_values(array_map(fn ($id) => InventoryPresenter::item($variants[$id], $costs), array_column($items, 'variant_id'))),
            'movements' => $movements->map(fn (InventoryMovement $m) => InventoryPresenter::movement($m))->values()->all(),
        ]]);
    }

    /** GET /stores/{store}/inventory/movements */
    public function movements(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:variant_id,product_id,reason,created_at'],
            'filter.variant_id' => ['sometimes', 'string', 'size:26'],
            'filter.product_id' => ['sometimes', 'string', 'size:26'],
            'filter.reason' => ['sometimes', 'string', 'regex:/^('.implode('|', InventoryMovement::REASONS).')(,('.implode('|', InventoryMovement::REASONS).'))*$/'],
            'filter.created_at' => ['sometimes', 'array:gte,lte'],
            'filter.created_at.gte' => ['sometimes', 'date'],
            'filter.created_at.lte' => ['sometimes', 'date'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = $input['filter'] ?? [];

        $paginator = InventoryMovement::query()->where('inventory_movements.store_id', $store->id)
            ->when(isset($filter['variant_id']), fn ($q) => $q->where('variant_id', strtolower($filter['variant_id'])))
            ->when(isset($filter['product_id']), fn ($q) => $q->whereIn('variant_id', ProductVariant::withTrashed()
                ->where('store_id', $store->id)->where('product_id', strtolower($filter['product_id']))->select('id')))
            ->when(isset($filter['reason']), fn ($q) => $q->whereIn('reason', explode(',', $filter['reason'])))
            ->when(isset($filter['created_at']['gte']), fn ($q) => $q->where('created_at', '>=', Carbon::parse($filter['created_at']['gte'])))
            ->when(isset($filter['created_at']['lte']), fn ($q) => $q->where('created_at', '<=', Carbon::parse($filter['created_at']['lte'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->with(['variant.product', 'actor'])
            ->paginate((int) ($input['per_page'] ?? 25));

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (InventoryMovement $m) => InventoryPresenter::movement($m))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    /** Non-deleted variants of non-deleted products of the store, joined with inventories. */
    private function base(Store $store): Builder
    {
        return ProductVariant::query()
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->join('inventories', 'inventories.variant_id', '=', 'product_variants.id')
            ->where('product_variants.store_id', $store->id)
            ->whereNull('products.deleted_at');
    }

    /** @return array<string, mixed> InventorySummary over the whole store */
    private function summary(Store $store, bool $costs): array
    {
        $onHand = 'CASE WHEN inventories.on_hand > 0 THEN inventories.on_hand ELSE 0 END';
        $row = $this->base($store)->toBase()->selectRaw(implode(', ', [
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
        return ProductVariant::query()->whereIn('id', $ids)->with(['inventory', 'product.images.media'])->get()->keyBy('id')->all();
    }

    /** @return array<string, mixed> */
    private function item(string $variantId): array
    {
        return InventoryPresenter::item($this->variants([$variantId])[$variantId], $this->costs());
    }

    private function costs(): bool
    {
        return Permission::ViewCosts->grantedTo($this->context->role());
    }
}
