<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Controllers;

use App\Domain\Purchasing\Http\Requests\PurchaseOrderRequest;
use App\Domain\Purchasing\Http\Requests\QuickPurchaseRequest;
use App\Domain\Purchasing\Http\Requests\ReceiveRequest;
use App\Domain\Purchasing\Http\Requests\TransitionRequest;
use App\Domain\Purchasing\Http\Resources\PurchasingPresenter;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\PurchaseOrderPdf;
use App\Domain\Purchasing\PurchaseOrderService;
use App\Domain\Purchasing\PurchasingInsights;
use App\Domain\Purchasing\ReceivingService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-8B §5, §8.1 `/stores/{store}/purchase-orders…`. List, detail and receipts also allow `inventory.adjust`
 * (P88B-11): such an actor gets every money/cost field null, `payment_status` null and no payments. `{purchase_order}`
 * resolves inside the store and tenant (else 404, S167). Every write returns the PurchaseOrderDetail.
 */
class PurchaseOrderController
{
    public const PER_PAGE = 25;

    public function __construct(
        private readonly PurchaseOrderService $orders,
        private readonly ReceivingService $receiving,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', PurchaseOrder::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,supplier_id'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.supplier_id' => ['sometimes', 'string', 'size:26'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $base = PurchaseOrder::query()->where('purchase_orders.store_id', $store->id)
            ->when(isset($input['filter']['supplier_id']), fn ($q) => $q->where('supplier_id', strtolower($input['filter']['supplier_id'])));
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $base->where(fn ($w) => $w->whereRaw('lower(number) like ?', [$like])
                ->orWhereIn('supplier_id', fn ($s) => $s->select('id')->from('suppliers')->where('tenant_id', $store->tenant_id)
                    ->where('store_id', $store->id)->whereRaw('lower(name) like ?', [$like])));
        }
        $counts = (clone $base)->toBase()->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status');
        $page = (clone $base)
            ->when(isset($input['filter']['status']), fn ($w) => $w->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->paginate((int) ($input['per_page'] ?? self::PER_PAGE));

        $byStatus = ['all' => (int) $counts->sum()];
        foreach (PurchaseOrder::STATUSES as $status) {
            $byStatus[$status] = (int) ($counts[$status] ?? 0);
        }

        return new JsonResponse([
            'data' => PurchasingPresenter::orders($store, $page->getCollection(), $this->money()),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $byStatus,
            ],
        ]);
    }

    public function summary(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => PurchasingInsights::orderSummary($store)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(PurchaseOrderRequest $request, Store $store): JsonResponse
    {
        return $this->detail($store, $this->orders->create($store, $request->validated(), $request->user()), 201);
    }

    public function quick(QuickPurchaseRequest $request, Store $store): JsonResponse
    {
        return $this->detail($store, $this->receiving->quick($store, $request->validated(), $request->user()), 201);
    }

    public function show(Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, self::find($store, $purchaseOrder));
    }

    public function update(PurchaseOrderRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, $this->orders->update($store, self::find($store, $purchaseOrder), $request->validated(), $request->user()));
    }

    public function destroy(TransitionRequest $request, Store $store, string $purchaseOrder): Response
    {
        $this->orders->delete($store, self::find($store, $purchaseOrder));

        return response()->noContent();
    }

    public function send(TransitionRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        $po = $this->orders->send($store, self::find($store, $purchaseOrder), (string) $request->validated('sent_via'), self::revision($request), $request->user());

        return $this->detail($store, $po);
    }

    public function markOrdered(TransitionRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, $this->orders->markOrdered($store, self::find($store, $purchaseOrder), self::revision($request), $request->user()));
    }

    public function close(TransitionRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, $this->orders->close($store, self::find($store, $purchaseOrder), self::revision($request), $request->user()));
    }

    public function cancel(TransitionRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, $this->orders->cancel($store, self::find($store, $purchaseOrder), self::revision($request), $request->user()));
    }

    public function receive(ReceiveRequest $request, Store $store, string $purchaseOrder): JsonResponse
    {
        return $this->detail($store, $this->receiving->receive($store, self::find($store, $purchaseOrder), $request->validated(), $request->user()), 201);
    }

    /** §5.6: inline, `PO-0012.pdf` (with DOCUMENTS_DRIVER=html the body is the HTML; the name stays `.pdf`). */
    public function pdf(Store $store, string $purchaseOrder, PurchaseOrderPdf $pdf): Response
    {
        $po = self::find($store, $purchaseOrder);
        $file = $pdf->render($store, $po);

        return new Response($file['bytes'], 200, [
            'Content-Type' => $file['mime'],
            'Content-Disposition' => 'inline; filename="'.$po->number.'.pdf"',
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public static function find(Store $store, string $id): PurchaseOrder
    {
        $row = PurchaseOrder::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    private function detail(Store $store, PurchaseOrder $po, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => PurchasingPresenter::detail($store, $po->refresh(), $this->money())], $status);
    }

    /** P88B-11: money and cost fields only for `purchasing.manage`. */
    private function money(): bool
    {
        return $this->context->allows(Permission::PurchasingManage);
    }

    private static function revision(Request $request): ?int
    {
        $value = $request->input('revision');

        return is_int($value) ? $value : null;
    }
}
