<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use App\Domain\Geo\AddressValidator;
use App\Domain\Orders\Http\OrderController;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Orders\OrderService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-4 §3 external orders: list (merchant filters + `filter[updated_since]`, per_page ≤ 100) with the merchant
 * `OrderSummary` / `OrderListMeta` shapes, detail and status changes through the merchant controller / OrderService (same state machine,
 * effects, events, notifications). Never refunds: cancelling a paid order needs `orders.refund`, which no key holds.
 */
class ExternalOrderController
{
    use ExternalLists;

    /** Target statuses an API key may set (P84 §3: every merchant transition except refunds). */
    public const STATUSES = [Order::CONFIRMED, Order::READY_TO_SHIP, Order::SHIPPED, Order::DELIVERED, Order::RETURNED, Order::CANCELLED];

    public function __construct(
        private readonly OrderService $orders,
        private readonly TenantContext $context,
    ) {}

    /**
     * Merchant list (`filter[status]`, …, `OrderListMeta`); `filter[updated_since]` (external only) pages by
     * `updated_at` ascending (sync order) with the merchant counts.
     */
    public function index(Request $request, Store $store): JsonResponse
    {
        $merchant = fn (Request $r) => app(OrderController::class)->index($r, $store);
        $since = self::updatedSince($request);
        if ($since === null) {
            return $merchant($request);
        }
        $request->validate(['page' => ['sometimes', 'integer', 'min:1'], 'per_page' => ['sometimes', 'integer', 'min:1', 'max:100']]);
        $meta = self::metaOf(self::merchantList($request, ['updated_since'], $merchant, metaOnly: true));

        $filter = array_diff_key((array) $request->query('filter', []), ['updated_since' => true]);
        $page = OrderController::filtered($store, $filter, trim((string) $request->query('q', '')), withStatus: true)
            ->where('orders.updated_at', '>=', $since)
            ->orderBy('orders.updated_at')->orderBy('orders.id')
            ->with(['customer', 'shipment'])->withSum('items', 'quantity')
            ->paginate((int) $request->query('per_page', 25));

        return self::page($page, $page->getCollection()->map(fn (Order $o) => OrderPresenter::summary($o))->all(), $meta);
    }

    public function show(Store $store, Order $order): JsonResponse
    {
        return app(OrderController::class)->show($store, $order);
    }

    /** POST /orders/{order}/status `{status, …}` (Idempotency-Key required by the route). */
    public function status(Request $request, Store $store, Order $order): JsonResponse
    {
        $input = $request->validate([
            'status' => ['required', 'string', Rule::in(self::STATUSES)],
            'notify_customer' => ['sometimes', 'boolean'],
            // shipped (manual shipment)
            'carrier_name' => ['sometimes', 'nullable', 'string', 'max:60'],
            'tracking_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'tracking_url' => ['sometimes', 'nullable', 'string', 'max:500', 'url:https', 'starts_with:https://'],
            // cancelled
            'reason' => ['sometimes', 'string', Rule::in(Order::CANCEL_REASONS)],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
            // returned
            'restock' => ['sometimes', 'array', 'max:'.Order::MAX_ITEMS],
            'restock.*.item_id' => ['required', 'string', 'max:26'],
            'restock.*.quantity' => ['required', 'integer:strict', 'min:0', 'max:99'],
        ]);
        $notify = $input['notify_customer'] ?? null;
        $note = AddressValidator::clean($input['note'] ?? null);
        // openapi 1.12.0: a paid order can only be cancelled with a refund, which the API never does → 409.
        if ($input['status'] === Order::CANCELLED && $order->paid_amount - $order->refunded_amount > 0) {
            throw new ApiException(409, 'invalid_state_transition', 'This order has been paid. Cancel it in the dashboard so the money can be refunded.');
        }

        match ($input['status']) {
            Order::CONFIRMED => $this->orders->confirm($order, null, $notify),
            Order::READY_TO_SHIP => $this->orders->ready($order, null),
            Order::SHIPPED => $this->orders->ship($order, array_map(
                fn ($v) => is_string($v) ? AddressValidator::clean($v) : $v,
                array_intersect_key($input, array_flip(['carrier_name', 'tracking_code', 'tracking_url'])),
            ), null, $notify),
            Order::DELIVERED => $this->orders->deliver($order, null),
            Order::RETURNED => $this->orders->return($order, $input['restock'] ?? [], $note, null),
            Order::CANCELLED => $this->orders->cancel($order, $input['reason'] ?? 'other', $note, $notify, null, $this->context->permissions()),
        };

        return app(OrderController::class)->show($store, $order);
    }
}
