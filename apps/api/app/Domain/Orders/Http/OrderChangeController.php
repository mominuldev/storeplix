<?php

namespace App\Domain\Orders\Http;

use App\Domain\Geo\AddressValidator;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderItemEditor;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Orders\OrderService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/** PHASE-5B §4.9 order changes: edit items (quote + apply) and restock after a courier return. O A S (`Operate`). */
class OrderChangeController
{
    public const REASONS = ['customer_request', 'out_of_stock', 'wrong_item', 'other'];

    public function __construct(
        private readonly OrderItemEditor $editor,
        private readonly OrderService $orders,
        private readonly TenantContext $context,
    ) {}

    public function quoteItems(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => $this->editor->quote($order, $this->validated($request, quote: true))]);
    }

    public function updateItems(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        [$order, $notices] = $this->editor->apply($order, $this->validated($request, quote: false), $request->user());

        return new JsonResponse([
            'data' => OrderPresenter::full(Order::query()->whereKey($order->id)->firstOrFail(), $this->context->permissions()),
            'meta' => ['notices' => $notices],
        ]);
    }

    public function restock(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'lines' => ['required', 'array', 'min:1', 'max:'.Order::MAX_ITEMS],
            'lines.*' => ['array:item_id,quantity'],
            'lines.*.item_id' => ['required', 'string', 'max:26'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:99'],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);
        $order = $this->orders->restock($order, $input['lines'], AddressValidator::clean($input['note'] ?? null), $request->user());

        return new JsonResponse(['data' => OrderPresenter::full(Order::query()->whereKey($order->id)->firstOrFail(), $this->context->permissions())]);
    }

    /** @return array<string, mixed> EditOrderItemsInput */
    private function validated(Request $request, bool $quote): array
    {
        $input = $request->validate([
            'revision' => [$quote ? 'sometimes' : 'required', 'integer:strict', 'min:1'],
            'items' => ['required', 'array', 'min:1', 'max:60'],
            'items.*' => ['array'], // unknown keys (unit_price_amount, …) are ignored, never applied (S39)
            'items.*.id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'items.*.variant_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'items.*.quantity' => ['required', 'integer:strict', 'min:0', 'max:99'],
            'reason' => [$quote ? 'sometimes' : 'required', 'string', 'in:'.implode(',', self::REASONS)],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'recalculate_shipping' => ['sometimes', 'boolean'],
            'shipping_amount_override' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000'],
            'notify_customer' => ['sometimes', 'boolean'],
        ]);
        $input['note'] = AddressValidator::clean($input['note'] ?? null);
        $input['reason'] ??= 'other';

        return $input;
    }
}
