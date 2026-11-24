<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Resources;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\Models\Media;
use App\Domain\Purchasing\LandedCost;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\PurchaseOrderItem;
use App\Domain\Purchasing\Models\PurchaseReceipt;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Purchasing\PurchaseHistory;
use App\Domain\Purchasing\PurchaseInvoices;
use App\Domain\Purchasing\SupplierStats;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Support\Collection;

/**
 * Purchasing payloads (@storeplix/types: Supplier, SupplierDetail, PurchaseOrder, PurchaseOrderDetail,
 * PurchaseOrderLine, PurchaseReceipt, SupplierPayment, PurchaseOrderEvent). `$money` = the actor holds
 * `purchasing.manage`; without it (an `inventory.adjust`-only receiver, P88B-11) every money/cost field is null and
 * payments are left out.
 */
final class PurchasingPresenter
{
    /**
     * @param  Collection<int, Supplier>  $suppliers
     * @return list<array<string, mixed>>
     */
    public static function suppliers(Store $store, Collection $suppliers): array
    {
        $stats = SupplierStats::forIds($store, $suppliers->pluck('id')->all());

        return $suppliers->map(fn (Supplier $s) => self::supplier($store, $s, $stats[$s->id]))->values()->all();
    }

    /** @param array<string, mixed>|null $stats @return array<string, mixed> Supplier */
    public static function supplier(Store $store, Supplier $supplier, ?array $stats = null): array
    {
        $stats ??= SupplierStats::forIds($store, [$supplier->id])[$supplier->id];

        return [
            'id' => $supplier->id,
            'name' => $supplier->name,
            'contact_name' => $supplier->contact_name,
            'phone' => $supplier->phone,
            'city' => $supplier->city,
            'supplies' => $supplier->supplies,
            'payment_terms_days' => $supplier->payment_terms_days,
            'advance_percent' => $supplier->advance_percent,
            'lead_time_days' => $supplier->lead_time_days,
            'pays_by_method' => $supplier->pays_by_method,
            'pays_by_account' => $supplier->pays_by_account,
            'notes' => $supplier->notes,
            'archived_at' => UserRef::iso($supplier->archived_at),
            'products_count' => $stats['products_count'],
            'open_pos_count' => $stats['open_pos_count'],
            'past_orders_count' => $stats['past_orders_count'],
            'currency' => $store->currency ?: 'BDT',
            'owed_amount' => $stats['owed_amount'],
            'overdue_amount' => $stats['overdue_amount'],
            'overdue_since' => $stats['overdue_since'],
            'last_order_on' => $stats['last_order_on'],
            'active_this_month' => $stats['active_this_month'],
            'created_by' => UserRef::of($supplier->relationLoaded('createdBy') ? $supplier->createdBy : $supplier->createdBy()->first()),
            'created_at' => UserRef::iso($supplier->created_at),
            'updated_at' => UserRef::iso($supplier->updated_at),
        ];
    }

    /** @return array<string, mixed> SupplierDetail */
    public static function supplierDetail(Store $store, Supplier $supplier): array
    {
        $recent = PurchaseOrder::query()->where('store_id', $store->id)->where('supplier_id', $supplier->id)
            ->orderByDesc('created_at')->orderByDesc('id')->limit(5)->get();

        return self::supplier($store, $supplier) + ['recent_purchase_orders' => self::orders($store, $recent, true)];
    }

    /**
     * @param  Collection<int, PurchaseOrder>  $orders
     * @return list<array<string, mixed>>
     */
    public static function orders(Store $store, Collection $orders, bool $money): array
    {
        $orders->loadMissing(['supplier', 'createdBy', 'items.variant.product.images.media']);

        return $orders->map(fn (PurchaseOrder $po) => self::order($store, $po, $money))->values()->all();
    }

    /** @return array<string, mixed> PurchaseOrder (list item); supplier, createdBy and items(.variant.product.images.media) loaded */
    public static function order(Store $store, PurchaseOrder $po, bool $money): array
    {
        $today = PurchaseHistory::today($store);
        $items = $po->items;
        $open = $po->isOpen();
        $late = $po->isLate($today);
        $m = fn (int $v) => $money ? $v : null;
        $preview = $items->take(2)->map(function (PurchaseOrderItem $i) {
            $product = $i->variant?->product;
            $cover = $product?->relationLoaded('images') ? $product->images->first() : null;

            return ['product_name' => (string) ($product?->name ?? ''), 'image' => MediaPresenter::ref($cover?->media)];
        })->values()->all();

        return [
            'id' => $po->id,
            'number' => $po->number,
            'status' => $po->status,
            'payment_status' => $money ? $po->paymentStatus() : null,
            'supplier' => self::supplierRef($po->supplier),
            'lines_count' => $items->count(),
            'preview_items' => $preview,
            'units_ordered' => (int) $items->sum('quantity_ordered'),
            'units_received' => (int) $items->sum('quantity_received'),
            'units_damaged' => (int) $items->sum('quantity_damaged'),
            'units_left' => $open || $po->status === PurchaseOrder::DRAFT ? (int) $items->sum(fn (PurchaseOrderItem $i) => $i->left()) : 0,
            'expected_on' => $po->expectedOn(),
            'is_late' => $late,
            'days_late' => $late ? (int) (new \DateTimeImmutable($po->expectedOn()))->diff(new \DateTimeImmutable($today))->days : null,
            'ordered_at' => UserRef::iso($po->ordered_at),
            'sent_at' => UserRef::iso($po->sent_at),
            'sent_via' => $po->sent_via,
            'closed_at' => UserRef::iso($po->closed_at),
            'cancelled_at' => UserRef::iso($po->cancelled_at),
            'due_on' => $po->dueOn(),
            'is_overdue' => $po->isOverdue($today),
            'currency' => $po->currency,
            'subtotal_amount' => $m($po->subtotal_amount),
            'shipping_amount' => $m($po->shipping_amount),
            'discount_amount' => $m($po->discount_amount),
            'total_amount' => $m($po->total_amount),
            'received_value_amount' => $m($po->received_value_amount),
            'paid_amount' => $m($po->paid_amount),
            'balance_amount' => $m($po->balance()),
            'revision' => $po->revision,
            'created_by' => UserRef::of($po->createdBy),
            'created_at' => UserRef::iso($po->created_at),
            'updated_at' => UserRef::iso($po->updated_at),
        ];
    }

    /** @return array<string, mixed> PurchaseOrderDetail */
    public static function detail(Store $store, PurchaseOrder $po, bool $money): array
    {
        $po->load(['supplier', 'createdBy', 'items.variant.product.images.media', 'items.variant.inventory']);
        $m = fn (?int $v) => $money ? $v : null;
        $items = $po->items;
        $landed = LandedCost::unitCosts(
            $items->map(fn (PurchaseOrderItem $i) => ['key' => $i->id, 'unit_cost' => $i->unit_cost_amount, 'quantity' => $i->quantity_ordered])->values()->all(),
            $po->shipping_amount, $po->discount_amount,
        );
        $lastBought = $money ? PurchaseHistory::lastUnitCosts($store, $items->pluck('variant_id')->all(), null, $po->id) : [];
        $supplierStats = SupplierStats::forIds($store, [$po->supplier_id])[$po->supplier_id];

        $lines = $items->map(function (PurchaseOrderItem $i) use ($m, $landed, $lastBought) {
            /** @var ProductVariant|null $variant */
            $variant = $i->variant;
            $product = $variant?->product;
            $cover = $product?->relationLoaded('images') ? $product->images->first() : null;
            /** @var Inventory|null $inventory */
            $inventory = $variant?->inventory;

            return [
                'id' => $i->id,
                'variant_id' => $i->variant_id,
                'product' => ['id' => (string) $product?->id, 'name' => (string) ($product?->name ?? ''), 'image' => MediaPresenter::ref($cover?->media)],
                'variant_title' => (string) ($variant?->title ?? ''),
                'option_values' => $variant !== null && $product !== null ? $variant->optionValues(count($product->options ?? [])) : [],
                'sku' => $variant?->sku,
                'unit_cost_amount' => $m($i->unit_cost_amount),
                'quantity_ordered' => $i->quantity_ordered,
                'quantity_received' => $i->quantity_received,
                'quantity_damaged' => $i->quantity_damaged,
                'quantity_left' => $i->left(),
                'line_total_amount' => $m($i->lineValue()),
                'landed_unit_cost_amount' => $m($landed[$i->id] ?? null),
                'in_stock' => (int) ($inventory?->on_hand ?? 0),
                'last_bought_unit_cost_amount' => $m($lastBought[$i->variant_id]['unit_cost'] ?? null),
                'position' => $i->position,
            ];
        })->values()->all();

        $receipts = PurchaseReceipt::query()->where('purchase_order_id', $po->id)->with(['items', 'receivedBy', 'invoice'])
            ->orderByDesc('received_at')->orderByDesc('id')->get();
        $payments = $money ? SupplierPayment::query()->where('purchase_order_id', $po->id)->with(['supplier', 'purchaseOrder', 'createdBy'])
            ->orderByDesc('paid_on')->orderByDesc('id')->get() : collect();

        $supplier = $po->supplier;

        return array_replace(self::order($store, $po, $money), [
            'supplier' => self::supplierRef($supplier) + [
                'contact_name' => $supplier->contact_name,
                'lead_time_days' => $supplier->lead_time_days,
                'payment_terms_days' => $supplier->payment_terms_days,
                'advance_percent' => $supplier->advance_percent,
                'pays_by_method' => $supplier->pays_by_method,
                'pays_by_account' => $supplier->pays_by_account,
                'past_orders_count' => $supplierStats['past_orders_count'],
                'archived_at' => UserRef::iso($supplier->archived_at),
                'owed_amount' => $m($supplierStats['owed_amount']),
            ],
            'notes' => $po->notes,
            'lines' => $lines,
            'receipts' => $receipts->map(fn (PurchaseReceipt $r) => self::receipt($r, $money))->values()->all(),
            'payments' => $payments->map(fn (SupplierPayment $p) => self::payment($p))->values()->all(),
            'events' => self::events($po, $money),
        ]);
    }

    /** @return array<string, mixed> PurchaseReceipt */
    public static function receipt(PurchaseReceipt $receipt, bool $money): array
    {
        $m = fn (?int $v) => $money ? $v : null;
        $items = $receipt->items;
        /** @var Media|null $invoice */
        $invoice = $receipt->invoice;

        return [
            'id' => $receipt->id,
            'received_at' => UserRef::iso($receipt->received_at),
            'received_by' => UserRef::of($receipt->receivedBy),
            'supplier_invoice_ref' => $receipt->supplier_invoice_ref,
            'invoice' => $invoice === null ? null : [
                'id' => $invoice->id,
                'mime' => $invoice->mime,
                'size_bytes' => (int) $invoice->size_bytes,
                'status' => $invoice->status,
                'url' => PurchaseInvoices::link($invoice),
            ],
            'note' => $receipt->note,
            'units_received' => (int) $items->sum('quantity_received'),
            'units_damaged' => (int) $items->sum('quantity_damaged'),
            'value_amount' => $m($receipt->value_amount),
            'lines' => $items->map(fn ($l) => [
                'item_id' => $l->purchase_order_item_id,
                'variant_id' => $l->variant_id,
                'quantity_received' => $l->quantity_received,
                'quantity_damaged' => $l->quantity_damaged,
                'landed_unit_cost_amount' => $m($l->landed_unit_cost_amount),
                'cost_before_amount' => $m($l->cost_before_amount),
                'cost_after_amount' => $m($l->cost_after_amount),
                'on_hand_before' => $l->on_hand_before,
            ])->values()->all(),
        ];
    }

    /** @return array<string, mixed> SupplierPayment (supplier, purchaseOrder, createdBy loaded) */
    public static function payment(SupplierPayment $payment): array
    {
        $po = $payment->purchaseOrder;

        return [
            'id' => $payment->id,
            'supplier' => ['id' => $payment->supplier_id, 'name' => (string) $payment->supplier?->name],
            'purchase_order' => $po === null ? null : ['id' => $po->id, 'number' => $po->number],
            'amount' => $payment->amount,
            'currency' => $payment->currency,
            'method' => $payment->method,
            'paid_on' => $payment->paidOn(),
            'reference' => $payment->reference,
            'note' => $payment->note,
            'created_by' => UserRef::of($payment->createdBy),
            'created_at' => UserRef::iso($payment->created_at),
        ];
    }

    /** @return array{id: string, name: string, phone: string|null, city: string|null} */
    private static function supplierRef(Supplier $supplier): array
    {
        return ['id' => $supplier->id, 'name' => $supplier->name, 'phone' => $supplier->phone, 'city' => $supplier->city];
    }

    /**
     * History (oldest first) from the audit trail of the PO and of payments linked to it (P88B-18). No "Approved by".
     *
     * @return list<array<string, mixed>>
     */
    private static function events(PurchaseOrder $po, bool $money): array
    {
        $types = [
            'purchasing.purchase_order_created' => 'created', 'purchasing.purchase_order_updated' => 'updated',
            'purchasing.purchase_order_sent' => 'sent', 'purchasing.purchase_order_marked_ordered' => 'marked_ordered',
            'purchasing.receipt_recorded' => 'received', 'purchasing.quick_received' => 'quick_received',
            'purchasing.purchase_order_closed' => 'closed', 'purchasing.purchase_order_cancelled' => 'cancelled',
            'purchasing.payment_recorded' => 'payment_recorded', 'purchasing.payment_deleted' => 'payment_deleted',
        ];
        $rows = AuditLog::query()->where('tenant_id', $po->tenant_id)
            ->where(fn ($q) => $q->where(fn ($w) => $w->where('subject_type', 'purchase_order')->where('subject_id', $po->id))
                ->orWhere(fn ($w) => $w->whereIn('action', ['purchasing.payment_recorded', 'purchasing.payment_deleted'])->where('meta->purchase_order_id', $po->id)))
            ->whereIn('action', array_keys($types))
            ->orderBy('created_at')->orderBy('id')->get();
        $users = User::query()->whereIn('id', $rows->where('actor_type', 'user')->pluck('actor_id')->filter()->unique()->values())->get()->keyBy('id');

        return $rows->map(function (AuditLog $row) use ($types, $users, $money) {
            $meta = $row->meta ?? [];
            $type = $types[$row->action];
            $receipt = in_array($type, ['received', 'quick_received'], true);

            return [
                'type' => $type,
                'actor' => $row->actor_type === 'user' ? UserRef::of($users->get($row->actor_id)) : null,
                'created_at' => UserRef::iso($row->created_at),
                'sent_via' => $type === 'sent' ? ($meta['sent_via'] ?? null) : null,
                'units' => $receipt ? (int) ($meta['units_received'] ?? 0) : null,
                'damaged' => $receipt ? (int) ($meta['units_damaged'] ?? 0) : null,
                'amount' => $money && str_starts_with($type, 'payment_') ? (int) ($meta['amount'] ?? 0) : null,
            ];
        })->values()->all();
    }
}
