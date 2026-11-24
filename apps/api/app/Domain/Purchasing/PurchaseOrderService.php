<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\PurchaseOrderItem;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Purchase order lifecycle (PHASE-8-8B §5.1, §5.2, P88B-2/3): draft → ordered (send / mark ordered) →
 * partially_received → received; closed (finish early) and cancelled (nothing received). Every write locks the PO row,
 * honours the optimistic `revision` (409 `revision_mismatch`), recomputes money server-side (S173) and audits.
 */
final class PurchaseOrderService
{
    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $input validated CreatePurchaseOrderInput */
    public function create(Store $store, array $input, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $input, $user) {
            $supplier = $this->activeSupplier($store, (string) $input['supplier_id']);
            $currency = (string) DB::table('stores')->where('tenant_id', $store->tenant_id)->where('id', $store->id)->sharedLock()->value('currency');
            $lines = $this->resolveLines($store, $supplier, $input['lines']);

            $po = new PurchaseOrder;
            $po->store_id = $store->id;
            $po->supplier_id = $supplier->id;
            $po->sequence = StoreCounter::next($store->id, StoreCounter::PURCHASE_ORDERS);
            $po->number = PurchaseOrder::numberFor($po->sequence);
            $po->status = PurchaseOrder::DRAFT;
            $po->expected_on = $input['expected_on'] ?? null;
            $po->notes = self::text($input['notes'] ?? null);
            $po->shipping_amount = (int) ($input['shipping_amount'] ?? 0);
            $po->discount_amount = (int) ($input['discount_amount'] ?? 0);
            $po->currency = $currency ?: 'BDT';
            $po->revision = 1;
            $po->created_by = $user->id;
            $po->updated_by = $user->id;
            self::applyTotals($po, array_sum(array_map(fn ($l) => $l['unit_cost'] * $l['quantity'], $lines)));
            $po->save();

            foreach ($lines as $position => $line) {
                $item = new PurchaseOrderItem;
                $item->store_id = $store->id;
                $item->purchase_order_id = $po->id;
                $item->variant_id = $line['variant_id'];
                $item->unit_cost_amount = $line['unit_cost'];
                $item->quantity_ordered = $line['quantity'];
                $item->position = $position;
                $item->save();
            }

            $this->audit->log('purchasing.purchase_order_created', $po, self::meta($po) + ['lines_count' => count($lines)]);

            return $po;
        });
    }

    /** @param array<string, mixed> $input validated UpdatePurchaseOrderInput (partial + revision) */
    public function update(Store $store, PurchaseOrder $po, array $input, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $input, $user) {
            $row = $this->lock($store, $po, $input['revision'] ?? null, PurchaseOrder::EDITABLE);
            $changed = [];

            if (array_key_exists('supplier_id', $input) && strtolower((string) $input['supplier_id']) !== $row->supplier_id) {
                if ($row->status !== PurchaseOrder::DRAFT) {
                    throw ValidationException::withMessages(['supplier_id' => ['The supplier can be changed only on a draft.']]);
                }
                // Review M2: payments are recorded against the supplier; moving the PO would split owed between two suppliers.
                if (SupplierPayment::query()->where('purchase_order_id', $row->id)->exists()) {
                    throw ValidationException::withMessages(['supplier_id' => ['This draft already has a payment to the supplier. Remove the payment first to change the supplier.']]);
                }
                $row->supplier_id = $this->activeSupplier($store, (string) $input['supplier_id'])->id;
                $changed[] = 'supplier_id';
            }
            foreach (['expected_on', 'notes'] as $field) {
                if (array_key_exists($field, $input)) {
                    $value = $field === 'notes' ? self::text($input[$field]) : $input[$field];
                    if ($value !== ($field === 'notes' ? $row->notes : $row->expectedOn())) {
                        $row->{$field} = $value;
                        $changed[] = $field;
                    }
                }
            }
            foreach (['shipping_amount', 'discount_amount'] as $field) {
                if (array_key_exists($field, $input) && (int) $input[$field] !== $row->{$field}) {
                    $row->{$field} = (int) $input[$field];
                    $changed[] = $field;
                }
            }

            if (array_key_exists('lines', $input)) {
                if ($this->replaceLines($store, $row, $input['lines'])) {
                    $changed[] = 'lines';
                }
            }

            self::applyTotals($row, (int) PurchaseOrderItem::query()->where('purchase_order_id', $row->id)->get()->sum(fn (PurchaseOrderItem $i) => $i->lineValue()));
            if ($changed === [] && ! $row->isDirty()) {
                return $row;
            }
            $row->revision++;
            $row->updated_by = $user->id;
            $row->save();
            $this->audit->log('purchasing.purchase_order_updated', $row, self::meta($row) + ['changed' => array_values(array_unique($changed))]);

            return $row;
        });
    }

    public function send(Store $store, PurchaseOrder $po, string $via, ?int $revision, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $via, $revision, $user) {
            $row = $this->lock($store, $po, $revision, [PurchaseOrder::DRAFT, PurchaseOrder::ORDERED]);
            if ($row->status === PurchaseOrder::DRAFT) {
                $row->status = PurchaseOrder::ORDERED;
                $row->ordered_at = now();
            }
            $row->sent_at = now();
            $row->sent_via = $via;

            return $this->saveTransition($row, $user, 'purchasing.purchase_order_sent', ['sent_via' => $via]);
        });
    }

    public function markOrdered(Store $store, PurchaseOrder $po, ?int $revision, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $revision, $user) {
            $row = $this->lock($store, $po, $revision, [PurchaseOrder::DRAFT]);
            $row->status = PurchaseOrder::ORDERED;
            $row->ordered_at = now();

            return $this->saveTransition($row, $user, 'purchasing.purchase_order_marked_ordered');
        });
    }

    public function close(Store $store, PurchaseOrder $po, ?int $revision, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $revision, $user) {
            $row = $this->lock($store, $po, $revision, PurchaseOrder::OPEN);
            $row->status = PurchaseOrder::CLOSED;
            $row->closed_at = now();
            $left = (int) PurchaseOrderItem::query()->where('purchase_order_id', $row->id)->get()->sum(fn (PurchaseOrderItem $i) => $i->left());

            return $this->saveTransition($row, $user, 'purchasing.purchase_order_closed', ['units_not_delivered' => $left]);
        });
    }

    public function cancel(Store $store, PurchaseOrder $po, ?int $revision, User $user): PurchaseOrder
    {
        return DB::transaction(function () use ($store, $po, $revision, $user) {
            $row = $this->lock($store, $po, $revision, [PurchaseOrder::DRAFT, PurchaseOrder::ORDERED]);
            $handled = PurchaseOrderItem::query()->where('purchase_order_id', $row->id)
                ->where(fn ($q) => $q->where('quantity_received', '>', 0)->orWhere('quantity_damaged', '>', 0))->exists();
            if ($handled) {
                throw self::invalidState('A purchase order with received items can’t be cancelled. Close it instead.');
            }
            $row->status = PurchaseOrder::CANCELLED;
            $row->cancelled_at = now();

            return $this->saveTransition($row, $user, 'purchasing.purchase_order_cancelled');
        });
    }

    public function delete(Store $store, PurchaseOrder $po): void
    {
        DB::transaction(function () use ($store, $po) {
            $row = $this->lock($store, $po, null, [PurchaseOrder::DRAFT]);
            $snapshot = self::meta($row) + ['lines_count' => PurchaseOrderItem::query()->where('purchase_order_id', $row->id)->count()];
            // Payments recorded against the draft (an advance) stay with the supplier, unlinked.
            DB::table('supplier_payments')->where('tenant_id', $row->tenant_id)->where('purchase_order_id', $row->id)->update(['purchase_order_id' => null, 'updated_at' => now()]);
            PurchaseOrderItem::query()->where('purchase_order_id', $row->id)->delete();
            $row->delete();
            $this->audit->log('purchasing.purchase_order_deleted', $row, $snapshot);
        });
    }

    /**
     * The PO row locked FOR UPDATE inside the store, with the optional revision check and the allowed statuses.
     *
     * @param  list<string>  $statuses
     */
    public function lock(Store $store, PurchaseOrder $po, ?int $revision, array $statuses): PurchaseOrder
    {
        /** @var PurchaseOrder $row */
        $row = PurchaseOrder::query()->where('store_id', $store->id)->whereKey($po->id)->lockForUpdate()->firstOrFail();
        if ($revision !== null && $revision !== $row->revision) {
            throw new ApiException(409, 'revision_conflict', 'This purchase order changed since you opened it. Reload and try again.', ['revision' => $row->revision]);
        }
        if (! in_array($row->status, $statuses, true)) {
            throw self::invalidState();
        }

        return $row;
    }

    public static function invalidState(string $message = 'This purchase order can’t do that in its current state.'): ApiException
    {
        return new ApiException(409, 'invalid_state_transition', $message);
    }

    /** subtotal / total from the lines; discount ≤ subtotal + shipping (S173). */
    public static function applyTotals(PurchaseOrder $po, int $subtotal): void
    {
        if ($po->discount_amount > $subtotal + $po->shipping_amount) {
            throw ValidationException::withMessages(['discount_amount' => ['The discount can’t be more than the items plus transport.']]);
        }
        $po->subtotal_amount = $subtotal;
        $po->total_amount = $subtotal + $po->shipping_amount - $po->discount_amount;
    }

    /** @return array<string, mixed> */
    public static function meta(PurchaseOrder $po): array
    {
        return ['number' => $po->number, 'supplier_id' => $po->supplier_id, 'status' => $po->status, 'total_amount' => $po->total_amount, 'currency' => $po->currency];
    }

    public function activeSupplier(Store $store, string $id): Supplier
    {
        /** @var Supplier|null $supplier */
        $supplier = Supplier::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($supplier === null) {
            throw ValidationException::withMessages(['supplier_id' => ['Unknown supplier.']]);
        }
        if ($supplier->isArchived()) {
            throw ValidationException::withMessages(['supplier_id' => ['This supplier is archived. Restore it first.']]);
        }

        return $supplier;
    }

    /**
     * Variants must be tracked inventory of this store (422 `variant_not_tracked`); a missing unit cost defaults to the
     * last unit cost from this supplier, else the variant's cost, else 0 (§5.1).
     *
     * @param  list<array<string, mixed>>  $lines
     * @return list<array{variant_id: string, unit_cost: int, quantity: int}>
     */
    public function resolveLines(Store $store, Supplier $supplier, array $lines, string $field = 'lines'): array
    {
        $ids = array_map(fn ($l) => strtolower((string) $l['variant_id']), $lines);
        $variants = self::variants($store, $ids);
        $untracked = [];
        foreach ($ids as $i => $id) {
            $variant = $variants[$id] ?? null;
            if ($variant === null) {
                throw ValidationException::withMessages(["{$field}.{$i}.variant_id" => ['Unknown variant.']]);
            }
            if (! $variant->track_inventory) {
                $untracked["{$field}.{$i}.variant_id"] = ['This product doesn’t track stock. Turn on stock tracking to buy it on a purchase order.'];
            }
        }
        if ($untracked !== []) {
            throw new ApiException(422, 'variant_not_tracked', 'Some products don’t track stock.', $untracked);
        }
        $last = PurchaseHistory::lastUnitCosts($store, $ids, $supplier->id);

        return array_values(array_map(fn ($line, $id) => [
            'variant_id' => $id,
            'unit_cost' => array_key_exists('unit_cost_amount', $line) && $line['unit_cost_amount'] !== null
                ? (int) $line['unit_cost_amount']
                : ($last[$id]['unit_cost'] ?? $variants[$id]->cost_amount ?? 0),
            'quantity' => (int) $line['quantity'],
        ], $lines, $ids));
    }

    /**
     * Non-deleted variants of non-deleted products of the store.
     *
     * @param  list<string>  $ids
     * @return array<string, ProductVariant>
     */
    public static function variants(Store $store, array $ids): array
    {
        return ProductVariant::query()->where('store_id', $store->id)->whereIn('id', $ids)
            ->whereHas('product')->get()->keyBy('id')->all();
    }

    /**
     * Replaces the line set, matched by variant: kept lines keep their received/damaged counts (and can't drop below
     * them), removed lines must have none (422). Returns whether anything changed.
     *
     * @param  list<array<string, mixed>>  $input
     */
    private function replaceLines(Store $store, PurchaseOrder $po, array $input): bool
    {
        $supplier = Supplier::query()->whereKey($po->supplier_id)->firstOrFail();
        $existing = PurchaseOrderItem::query()->where('purchase_order_id', $po->id)->get()->keyBy('variant_id');
        $lines = $this->resolveLines($store, $supplier, array_map(function ($l) use ($existing) {
            $id = strtolower((string) $l['variant_id']);
            if (! array_key_exists('unit_cost_amount', $l) && $existing->has($id)) {
                $l['unit_cost_amount'] = $existing[$id]->unit_cost_amount; // keep the line's cost when not sent
            }

            return $l;
        }, $input));

        $errors = [];
        $keep = [];
        foreach ($lines as $i => $line) {
            $item = $existing->get($line['variant_id']);
            if ($item !== null && $line['quantity'] < $item->quantity_received + $item->quantity_damaged) {
                $errors["lines.{$i}.quantity"] = ['Already '.($item->quantity_received + $item->quantity_damaged).' received. The quantity can’t be lower.'];
            }
            $keep[$line['variant_id']] = true;
        }
        foreach ($existing as $variantId => $item) {
            if (! isset($keep[$variantId]) && $item->quantity_received + $item->quantity_damaged > 0) {
                $errors['lines'][] = 'A line with received items can’t be removed.';
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        $changed = false;
        foreach ($existing as $variantId => $item) {
            if (! isset($keep[$variantId])) {
                $item->delete();
                $changed = true;
            }
        }
        foreach ($lines as $position => $line) {
            $item = $existing->get($line['variant_id']) ?? new PurchaseOrderItem;
            if (! $item->exists) {
                $item->store_id = $store->id;
                $item->purchase_order_id = $po->id;
                $item->variant_id = $line['variant_id'];
            }
            $item->unit_cost_amount = $line['unit_cost'];
            $item->quantity_ordered = $line['quantity'];
            $item->position = $position;
            if ($item->isDirty()) {
                $changed = true;
                $item->save();
            }
        }

        return $changed;
    }

    /** @param array<string, mixed> $meta */
    private function saveTransition(PurchaseOrder $row, User $user, string $action, array $meta = []): PurchaseOrder
    {
        $row->revision++;
        $row->updated_by = $user->id;
        $row->save();
        $this->audit->log($action, $row, self::meta($row) + $meta);

        return $row;
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
