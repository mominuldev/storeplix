<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Controllers;

use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** PHASE-8-8 §5.3 POST …/orders/{order}/guard/release (perm:orders.process) → the Order; 409 `order_not_held`. */
class OrderGuardController
{
    public function __construct(
        private readonly FraudGuard $guard,
        private readonly TenantContext $context,
    ) {}

    public function release(Request $request, Store $store, string $order): JsonResponse
    {
        $row = Order::query()->where('store_id', $store->id)->whereKey(strtolower($order))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        $this->guard->release($row, $request->user());

        return new JsonResponse(['data' => OrderPresenter::full(Order::query()->whereKey($row->id)->firstOrFail(), $this->context->permissions())]);
    }
}
