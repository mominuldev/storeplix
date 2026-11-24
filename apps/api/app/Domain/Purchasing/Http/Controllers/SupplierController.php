<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Controllers;

use App\Domain\Purchasing\Http\Requests\SupplierPaymentRequest;
use App\Domain\Purchasing\Http\Requests\SupplierRequest;
use App\Domain\Purchasing\Http\Requests\TransitionRequest;
use App\Domain\Purchasing\Http\Resources\PurchasingPresenter;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Purchasing\PurchasingInsights;
use App\Domain\Purchasing\SupplierPaymentService;
use App\Domain\Purchasing\SupplierService;
use App\Domain\Purchasing\SupplierStats;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-8B §4, §6 `/stores/{store}/suppliers…` (perm:purchasing.manage). `{supplier}` resolves inside the store and
 * the tenant: another store's or tenant's id → 404 `not_found` (S167). Writes need plan `purchasing` (402, S169).
 */
class SupplierController
{
    public const PER_PAGE = 50;

    public function __construct(
        private readonly SupplierService $suppliers,
        private readonly SupplierPaymentService $payments,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'filter' => ['sometimes', 'array:archived'],
            'filter.archived' => ['sometimes', 'string', 'in:true,false,1,0'],
            'archived' => ['sometimes', 'string', 'in:true,false,1,0'],
            'sort' => ['sometimes', 'string', 'in:name,-owed_amount,-last_order_on'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $archivedFlag = $input['filter']['archived'] ?? $input['archived'] ?? 'false';
        $archived = in_array($archivedFlag, ['true', '1'], true);

        $query = Supplier::query()->where('store_id', $store->id)
            ->when($archived, fn ($q) => $q->whereNotNull('archived_at'), fn ($q) => $q->whereNull('archived_at'));
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $digits = preg_replace('/\D/', '', $q) ?? '';
            $query->where(function ($w) use ($like, $digits) {
                $w->whereRaw('lower(name) like ?', [$like])->orWhereRaw('lower(city) like ?', [$like]);
                if (strlen($digits) >= 3) {
                    $w->orWhere('phone', 'like', '%'.ltrim($digits, '0').'%');
                }
            });
        }
        match ($input['sort'] ?? 'name') {
            '-owed_amount' => $query->orderByRaw(SupplierStats::owedSql().' desc')->orderBy('name')->orderBy('id'),
            '-last_order_on' => $query->orderByRaw(SupplierStats::lastOrderSql().' IS NULL')->orderByRaw(SupplierStats::lastOrderSql().' desc')->orderBy('id'),
            default => $query->orderByRaw('lower(name)')->orderBy('id'),
        };
        $page = $query->with('createdBy')->paginate((int) ($input['per_page'] ?? self::PER_PAGE));
        $counts = Supplier::query()->where('store_id', $store->id)
            ->selectRaw('sum(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) as active, sum(CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END) as archived')->first();

        return new JsonResponse([
            'data' => PurchasingPresenter::suppliers($store, $page->getCollection()),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => ['active' => (int) ($counts->active ?? 0), 'archived' => (int) ($counts->archived ?? 0)],
            ],
        ]);
    }

    public function summary(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => PurchasingInsights::supplierSummary($store)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(SupplierRequest $request, Store $store): JsonResponse
    {
        $supplier = $this->suppliers->create($store, $request->validated(), $request->user());

        return new JsonResponse(['data' => PurchasingPresenter::supplier($store, $supplier->refresh())], 201);
    }

    public function show(Store $store, string $supplier): JsonResponse
    {
        return new JsonResponse(['data' => PurchasingPresenter::supplierDetail($store, self::find($store, $supplier))]);
    }

    public function update(SupplierRequest $request, Store $store, string $supplier): JsonResponse
    {
        $row = $this->suppliers->update($store, self::find($store, $supplier), $request->validated(), $request->user());

        return new JsonResponse(['data' => PurchasingPresenter::supplier($store, $row->refresh())]);
    }

    public function archive(TransitionRequest $request, Store $store, string $supplier): JsonResponse
    {
        return $this->setArchived($store, $supplier, true);
    }

    public function unarchive(TransitionRequest $request, Store $store, string $supplier): JsonResponse
    {
        return $this->setArchived($store, $supplier, false);
    }

    public function destroy(TransitionRequest $request, Store $store, string $supplier): Response
    {
        $this->suppliers->delete($store, self::find($store, $supplier));

        return response()->noContent();
    }

    public function payments(Request $request, Store $store, string $supplier): JsonResponse
    {
        $input = $request->validate(['page' => ['sometimes', 'integer', 'min:1'], 'per_page' => ['sometimes', 'integer', 'min:1', 'max:100']]);
        $row = self::find($store, $supplier);
        $page = SupplierPayment::query()->where('store_id', $store->id)->where('supplier_id', $row->id)
            ->with(['supplier', 'purchaseOrder', 'createdBy'])->orderByDesc('paid_on')->orderByDesc('id')
            ->paginate((int) ($input['per_page'] ?? self::PER_PAGE));

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (SupplierPayment $p) => PurchasingPresenter::payment($p))->values()->all(),
            'meta' => ['current_page' => $page->currentPage(), 'per_page' => $page->perPage(), 'total' => $page->total(), 'last_page' => $page->lastPage()],
        ]);
    }

    public function recordPayment(SupplierPaymentRequest $request, Store $store, string $supplier): JsonResponse
    {
        $payment = $this->payments->record($store, self::find($store, $supplier), $request->validated(), $request->user());

        return new JsonResponse(['data' => PurchasingPresenter::payment($payment->refresh()->load(['supplier', 'purchaseOrder', 'createdBy']))], 201);
    }

    public static function find(Store $store, string $id): Supplier
    {
        $row = Supplier::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    private function setArchived(Store $store, string $supplier, bool $archived): JsonResponse
    {
        $row = $this->suppliers->archive($store, self::find($store, $supplier), $archived);

        return new JsonResponse(['data' => PurchasingPresenter::supplier($store, $row->refresh())]);
    }
}
