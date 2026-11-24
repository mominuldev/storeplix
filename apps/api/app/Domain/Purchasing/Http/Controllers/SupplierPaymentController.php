<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Controllers;

use App\Domain\Purchasing\Http\Requests\TransitionRequest;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Purchasing\SupplierPaymentService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Response;

/** PHASE-8-8B §6.2 `DELETE /stores/{store}/supplier-payments/{payment}` (perm:purchasing.manage, plan) → 204, audited. */
class SupplierPaymentController
{
    public function __construct(private readonly SupplierPaymentService $payments) {}

    public function destroy(TransitionRequest $request, Store $store, string $payment): Response
    {
        $row = SupplierPayment::query()->where('store_id', $store->id)->whereKey(strtolower($payment))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        $this->payments->delete($store, $row, $request->user());

        return response()->noContent();
    }
}
