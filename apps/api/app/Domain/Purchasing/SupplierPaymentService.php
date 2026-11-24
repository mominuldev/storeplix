<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Identity\Models\User;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Supplier payments (PHASE-8-8B §6.2, P88B-8): records only (no payout). A payment linked to a PO refreshes the PO's
 * `paid_amount` (always re-summed from the payments, never incremented blindly). Never writes `expenses` (P88B-10).
 */
final class SupplierPaymentService
{
    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $input validated SupplierPaymentInput */
    public function record(Store $store, Supplier $supplier, array $input, User $user, bool $audit = true): SupplierPayment
    {
        return DB::transaction(function () use ($store, $supplier, $input, $user, $audit) {
            $currency = (string) DB::table('stores')->where('tenant_id', $store->tenant_id)->where('id', $store->id)->sharedLock()->value('currency');
            if (isset($input['currency']) && strtoupper((string) $input['currency']) !== $currency) {
                throw ValidationException::withMessages(['currency' => ["The currency must be your shop's currency ({$currency})."]]);
            }
            $po = null;
            if (($input['purchase_order_id'] ?? null) !== null) {
                /** @var PurchaseOrder|null $po */
                $po = PurchaseOrder::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['purchase_order_id']))->lockForUpdate()->first();
                if ($po === null || $po->supplier_id !== $supplier->id) {
                    throw ValidationException::withMessages(['purchase_order_id' => ['This purchase order is not from this supplier.']]);
                }
                if ($po->status === PurchaseOrder::CANCELLED) {
                    throw ValidationException::withMessages(['purchase_order_id' => ['This purchase order is cancelled.']]);
                }
            }

            $payment = new SupplierPayment;
            $payment->store_id = $store->id;
            $payment->supplier_id = $supplier->id;
            $payment->purchase_order_id = $po?->id;
            $payment->amount = (int) $input['amount'];
            $payment->currency = $currency ?: 'BDT';
            $payment->method = (string) $input['method'];
            $payment->paid_on = (string) $input['paid_on'];
            $payment->reference = self::text($input['reference'] ?? null);
            $payment->note = self::text($input['note'] ?? null);
            $payment->created_by = $user->id;
            $payment->save();

            if ($po !== null) {
                $this->refreshPaid($po, $user);
            }
            if ($audit) {
                $this->audit->log('purchasing.payment_recorded', $payment, self::snapshot($payment, $po));
            }

            return $payment;
        });
    }

    public function delete(Store $store, SupplierPayment $payment, User $user): void
    {
        DB::transaction(function () use ($store, $payment, $user) {
            $po = $payment->purchase_order_id === null ? null
                : PurchaseOrder::query()->where('store_id', $store->id)->whereKey($payment->purchase_order_id)->lockForUpdate()->first();
            /** @var SupplierPayment $row */
            $row = SupplierPayment::query()->where('store_id', $store->id)->whereKey($payment->id)->lockForUpdate()->firstOrFail();
            $snapshot = self::snapshot($row, $po) + ['reference' => $row->reference, 'note' => $row->note];
            $row->delete();
            if ($po !== null) {
                $this->refreshPaid($po, $user);
            }
            $this->audit->log('purchasing.payment_deleted', $row, $snapshot);
        });
    }

    /**
     * Re-sums `paid_amount` of a locked PO from its payments (P88B-8). The PO `revision` is NOT bumped: `paid_amount` is
     * not an editable field, so a payment must not make the merchant's open edit form stale (review M1).
     */
    public function refreshPaid(PurchaseOrder $po, User $user): void
    {
        $po->paid_amount = (int) SupplierPayment::query()->where('purchase_order_id', $po->id)->sum('amount');
        if ($po->isDirty('paid_amount')) {
            $po->updated_by = $user->id;
            $po->save();
        }
    }

    /** @return array<string, mixed> */
    private static function snapshot(SupplierPayment $payment, ?PurchaseOrder $po): array
    {
        return [
            'supplier_id' => $payment->supplier_id,
            'purchase_order_id' => $payment->purchase_order_id,
            'purchase_order_number' => $po?->number,
            'amount' => $payment->amount,
            'currency' => $payment->currency,
            'method' => $payment->method,
            'paid_on' => $payment->paidOn(),
        ];
    }

    private static function text(mixed $value): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $value = trim($value);

        return $value === '' ? null : $value;
    }
}
