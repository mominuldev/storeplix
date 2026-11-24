<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\PurchaseOrderItem;
use App\Domain\Purchasing\Models\PurchaseReceipt;
use App\Domain\Purchasing\Models\PurchaseReceiptItem;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Receiving (PHASE-8-8B §5.3–§5.5, P88B-4/5/6/13). One transaction: lock the PO (FOR UPDATE; concurrent receipts
 * serialise here and never exceed ordered, S170) → validate left quantities (422 `over_receive`) → lock the inventory
 * rows in variant_id order and read on hand BEFORE the adjust → one `InventoryService::adjust` call (reason `received`,
 * reference the PO; damaged units never stocked, S171) → weighted-average landed cost written to the variant (P88B-5;
 * also for actors who can't see costs) → receipt rows with the cost trail → PO counters / status / received value /
 * due date → audit. Stock and cost never change any other way. Purchases never write `expenses` (P88B-10).
 */
final class ReceivingService
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly PurchaseOrderService $orders,
        private readonly SupplierPaymentService $payments,
        private readonly PurchaseInvoices $invoices,
        private readonly AuditLogger $audit,
    ) {}

    /** @param array<string, mixed> $input validated ReceivePurchaseOrderInput */
    public function receive(Store $store, PurchaseOrder $po, array $input, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $input, $user) {
            $row = $this->orders->lock($store, $po, null, PurchaseOrder::OPEN);
            [$receipt, $meta] = $this->record($store, $row, $input['lines'], $input, $user);
            $this->audit->log('purchasing.receipt_recorded', $row, PurchaseOrderService::meta($row) + ['receipt_id' => $receipt->id] + $meta);

            return $row;
        });
    }

    /** @param array<string, mixed> $input validated QuickPurchaseInput */
    public function quick(Store $store, array $input, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $input, $user) {
            $supplier = $this->orders->activeSupplier($store, (string) $input['supplier_id']);
            $currency = (string) DB::table('stores')->where('tenant_id', $store->tenant_id)->where('id', $store->id)->sharedLock()->value('currency');
            $lines = $this->orders->resolveLines($store, $supplier, $input['lines']);
            $damaged = [];
            foreach ($input['lines'] as $i => $line) {
                $d = (int) ($line['damaged'] ?? 0);
                if ($d > (int) $line['quantity']) {
                    throw ValidationException::withMessages(["lines.{$i}.damaged" => ['Damaged can’t be more than the quantity.']]);
                }
                $damaged[strtolower((string) $line['variant_id'])] = $d;
            }

            $po = new PurchaseOrder;
            $po->store_id = $store->id;
            $po->supplier_id = $supplier->id;
            $po->sequence = StoreCounter::next($store->id, StoreCounter::PURCHASE_ORDERS);
            $po->number = PurchaseOrder::numberFor($po->sequence);
            $po->status = PurchaseOrder::ORDERED;
            $po->ordered_at = now();
            $po->notes = isset($input['notes']) && is_string($input['notes']) && trim($input['notes']) !== '' ? trim($input['notes']) : null;
            $po->shipping_amount = (int) ($input['shipping_amount'] ?? 0);
            $po->discount_amount = (int) ($input['discount_amount'] ?? 0);
            $po->currency = $currency ?: 'BDT';
            $po->revision = 1;
            $po->created_by = $user->id;
            $po->updated_by = $user->id;
            PurchaseOrderService::applyTotals($po, array_sum(array_map(fn ($l) => $l['unit_cost'] * $l['quantity'], $lines)));
            $po->save();

            $receive = [];
            foreach ($lines as $position => $line) {
                $item = new PurchaseOrderItem;
                $item->store_id = $store->id;
                $item->purchase_order_id = $po->id;
                $item->variant_id = $line['variant_id'];
                $item->unit_cost_amount = $line['unit_cost'];
                $item->quantity_ordered = $line['quantity'];
                $item->position = $position;
                $item->save();
                $d = $damaged[$line['variant_id']] ?? 0;
                $receive[] = ['item_id' => $item->id, 'received' => $line['quantity'] - $d, 'damaged' => $d];
            }

            [$receipt, $meta] = $this->record($store, $po, $receive, $input, $user);
            $payment = null;
            if (($input['payment'] ?? null) !== null) {
                $payment = $this->payments->record($store, $supplier, ['purchase_order_id' => $po->id] + $input['payment'], $user, audit: false);
                $po->refresh();
            }

            $this->audit->log('purchasing.quick_received', $po, PurchaseOrderService::meta($po) + ['receipt_id' => $receipt->id] + $meta + [
                'payment' => $payment === null ? null : ['id' => $payment->id, 'amount' => $payment->amount, 'method' => $payment->method, 'paid_on' => $payment->paidOn()],
            ]);

            return $po;
        });
    }

    /**
     * Records one receipt on a LOCKED open PO.
     *
     * @param  list<array<string, mixed>>  $lines  [{item_id, received, damaged}]
     * @param  array<string, mixed>  $extras  supplier_invoice_ref, invoice_media_id, note
     * @return array{0: PurchaseReceipt, 1: array<string, mixed>} the receipt and its audit meta
     */
    private function record(Store $store, PurchaseOrder $po, array $lines, array $extras, User $user): array
    {
        /** @var Collection<string, PurchaseOrderItem> $items */
        $items = PurchaseOrderItem::query()->where('purchase_order_id', $po->id)->orderBy('position')->orderBy('id')->get()->keyBy('id');

        $wanted = [];
        $errors = [];
        $over = [];
        foreach (array_values($lines) as $i => $line) {
            $id = strtolower((string) $line['item_id']);
            $item = $items->get($id);
            if ($item === null) {
                $errors["lines.{$i}.item_id"] = ['This line is not on the purchase order.'];

                continue;
            }
            if (isset($wanted[$id])) {
                $errors["lines.{$i}.item_id"] = ['This line is listed twice.'];

                continue;
            }
            $received = (int) $line['received'];
            $damaged = (int) ($line['damaged'] ?? 0);
            if ($received + $damaged > $item->left()) {
                $over["lines.{$i}.received"] = [$item->left() === 0 ? 'Nothing is left to receive on this line.' : "Only {$item->left()} left to receive."];
            }
            $wanted[$id] = [$item, $received, $damaged];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
        if ($over !== []) {
            throw new ApiException(422, 'over_receive', 'You can’t receive more than is left on the purchase order.', $over);
        }
        $wanted = array_filter($wanted, fn ($w) => $w[1] + $w[2] > 0);
        if ($wanted === []) {
            throw ValidationException::withMessages(['lines' => ['Enter at least one received or damaged quantity.']]);
        }

        $invoice = ($extras['invoice_media_id'] ?? null) !== null ? $this->invoices->attachable((string) $extras['invoice_media_id']) : null;
        $supplier = Supplier::query()->whereKey($po->supplier_id)->firstOrFail();

        // §5.4: landed unit costs from the PO's current transport/discount over ALL its lines.
        $landed = LandedCost::unitCosts(
            $items->map(fn (PurchaseOrderItem $i) => ['key' => $i->id, 'unit_cost' => $i->unit_cost_amount, 'quantity' => $i->quantity_ordered])->values()->all(),
            $po->shipping_amount, $po->discount_amount,
        );

        // On hand BEFORE the adjust, read under the inventory row locks (variant_id order, the InventoryService order).
        $variantIds = array_values(array_unique(array_map(fn ($w) => $w[0]->variant_id, $wanted)));
        sort($variantIds, SORT_STRING);
        $onHand = Inventory::query()->where('store_id', $store->id)->whereIn('variant_id', $variantIds)
            ->orderBy('variant_id')->lockForUpdate()->pluck('on_hand', 'variant_id')->map(fn ($v) => (int) $v)->all();

        $adjust = [];
        foreach ($wanted as [$item, $received]) {
            if ($received > 0) {
                $adjust[] = ['variant_id' => $item->variant_id, 'mode' => 'delta', 'quantity' => $received];
            }
        }
        if ($adjust !== []) {
            $this->inventory->adjust($store->id, 'received', "{$po->number} · {$supplier->name}", $adjust, $user->id, ['type' => 'purchase_order', 'id' => $po->id]);
        }

        $receipt = new PurchaseReceipt;
        $receipt->store_id = $store->id;
        $receipt->purchase_order_id = $po->id;
        $receipt->received_at = now();
        $receipt->received_by = $user->id;
        $receipt->supplier_invoice_ref = self::text($extras['supplier_invoice_ref'] ?? null);
        $receipt->invoice_media_id = $invoice?->id;
        $receipt->note = self::text($extras['note'] ?? null);
        $receipt->value_amount = 0;
        $receipt->save();

        $costs = ProductVariant::withTrashed()->whereIn('id', $variantIds)->pluck('cost_amount', 'id')->all();
        $value = 0;
        $units = 0;
        $broken = 0;
        $auditLines = [];
        foreach ($wanted as [$item, $received, $damaged]) {
            $unit = $landed[$item->id] ?? 0;
            $before = $costs[$item->variant_id] ?? null;
            $before = $before === null ? null : (int) $before;
            $stock = $onHand[$item->variant_id] ?? 0;
            $after = $received > 0 ? LandedCost::weightedAverage($before, $stock, $received, $unit) : $before;
            if ($received > 0 && $after !== $before) {
                ProductVariant::withTrashed()->whereKey($item->variant_id)->update(['cost_amount' => $after, 'updated_at' => now()]);
            }

            $line = new PurchaseReceiptItem;
            $line->store_id = $store->id;
            $line->purchase_receipt_id = $receipt->id;
            $line->purchase_order_item_id = $item->id;
            $line->variant_id = $item->variant_id;
            $line->quantity_received = $received;
            $line->quantity_damaged = $damaged;
            $line->landed_unit_cost_amount = $unit;
            $line->cost_before_amount = $before;
            $line->cost_after_amount = $after;
            $line->on_hand_before = $stock;
            $line->created_at = now();
            $line->save();

            $item->quantity_received += $received;
            $item->quantity_damaged += $damaged;
            $item->save();

            $value += $received * $unit;
            $units += $received;
            $broken += $damaged;
            $auditLines[] = ['variant_id' => $item->variant_id, 'received' => $received, 'damaged' => $damaged, 'landed_unit_cost' => $unit, 'cost_before' => $before, 'cost_after' => $after];
        }
        $receipt->value_amount = $value;
        $receipt->save();

        $left = (int) $items->sum(fn (PurchaseOrderItem $i) => $i->left());
        $po->status = $left === 0 ? PurchaseOrder::RECEIVED : PurchaseOrder::PARTIALLY_RECEIVED;
        $po->received_value_amount += $value;
        if ($po->due_on === null) {
            $po->due_on = CarbonImmutable::now(PurchaseHistory::tz($store))->addDays((int) ($supplier->payment_terms_days ?? 0))->format('Y-m-d');
        }
        $po->revision++;
        $po->updated_by = $user->id;
        $po->save();

        return [$receipt, ['units_received' => $units, 'units_damaged' => $broken, 'value_amount' => $value, 'lines' => $auditLines]];
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
