<?php

namespace App\Domain\Inventory;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use LogicException;

/**
 * The ONLY writer of inventories.on_hand, inventories.committed and inventory_movements (P4-12, P4-13, P5-5).
 *
 * adjust(): one transaction; rows are locked with SELECT … FOR UPDATE in variant_id order (no deadlocks between
 * parallel requests); all-or-nothing; never negative; one ledger row per changed variant; zero delta writes nothing.
 *
 * Orders (ADR 0011): commit() at placement adds to `committed` (no ledger row), release() on cancel gives it back,
 * ship() moves the quantity out of both on_hand and committed (ledger `order_shipped`), restock() puts returned units
 * back on hand (ledger `order_returned`). They run inside the caller's order transaction and use the same lock order
 * (inventories by variant_id), so checkout, cancel, ship and return never deadlock each other.
 */
class InventoryService
{
    public function __construct(private readonly TenantContext $context) {}

    /**
     * Creates the inventory row of a NEW variant (always, also when untracked) plus an `initial` movement.
     * Must run inside the caller's transaction.
     */
    public function createFor(ProductVariant $variant, int $initialOnHand = 0, ?int $threshold = null, ?string $actorId = null): Inventory
    {
        $inventory = new Inventory(['low_stock_threshold' => $threshold]);
        $inventory->store_id = $variant->store_id;
        $inventory->variant_id = $variant->id;
        $inventory->on_hand = $initialOnHand;
        $inventory->save();

        if ($initialOnHand !== 0) {
            $this->insertMovements([$this->movementRow($variant->store_id, $variant->id, $initialOnHand, $initialOnHand, 'initial', null, null, null, $actorId)]);
        }

        return $inventory;
    }

    /**
     * Bulk variant of createFor() for imports: multi-row inserts. $rows: [variant_id, store_id, on_hand, threshold].
     *
     * @param  list<array{variant_id: string, store_id: string, on_hand: int, threshold: int|null}>  $rows
     * @param  array{type: string, id: string}|null  $reference
     */
    public function createMany(array $rows, string $reason, ?array $reference, ?string $actorId): void
    {
        if ($rows === []) {
            return;
        }
        $tenantId = $this->context->requireId();
        $now = now();
        $inventories = [];
        $movements = [];
        foreach ($rows as $row) {
            $inventories[] = [
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $tenantId,
                'store_id' => $row['store_id'],
                'variant_id' => $row['variant_id'],
                'on_hand' => $row['on_hand'],
                'committed' => 0,
                'low_stock_threshold' => $row['threshold'],
                'created_at' => $now,
                'updated_at' => $now,
            ];
            if ($row['on_hand'] !== 0) {
                $movements[] = $this->movementRow($row['store_id'], $row['variant_id'], $row['on_hand'], $row['on_hand'], $reason, null, $reference['type'] ?? null, $reference['id'] ?? null, $actorId);
            }
        }
        foreach (array_chunk($inventories, 200) as $chunk) {
            Inventory::query()->insert($chunk);
        }
        $this->insertMovements($movements);
    }

    /**
     * @param  list<array{variant_id: string, mode: string, quantity: int, expected_on_hand?: int|null}>  $items  variant ids
     *                                                                                                            already checked against the store
     * @param  array{type: string, id: string}|null  $reference
     * @return array{inventories: array<string, Inventory>, movements: list<InventoryMovement>}
     */
    public function adjust(string $storeId, string $reason, ?string $note, array $items, ?string $actorId, ?array $reference = null): array
    {
        return DB::transaction(function () use ($storeId, $reason, $note, $items, $actorId, $reference) {
            $ids = array_values(array_unique(array_column($items, 'variant_id')));
            sort($ids, SORT_STRING);

            /** @var array<string, Inventory> $rows */
            $rows = Inventory::query()->where('store_id', $storeId)->whereIn('variant_id', $ids)
                ->orderBy('variant_id')->lockForUpdate()->get()->keyBy('variant_id')->all();

            $changed = [];
            $stale = [];
            $insufficient = [];
            foreach ($items as $i => $item) {
                $row = $rows[$item['variant_id']] ?? null;
                if ($row === null) {
                    throw new ApiException(422, 'validation_failed', 'The given data was invalid.', ["items.{$i}.variant_id" => ['Unknown variant.']]);
                }
                $old = $row->on_hand;
                if (array_key_exists('expected_on_hand', $item) && $item['expected_on_hand'] !== null && (int) $item['expected_on_hand'] !== $old) {
                    $stale["items.{$i}.expected_on_hand"] = ["Stock changed to {$old} since you opened this. Check and try again."];

                    continue;
                }
                $new = $item['mode'] === 'set' ? (int) $item['quantity'] : $old + (int) $item['quantity'];
                if ($new < 0) {
                    $insufficient["items.{$i}.quantity"] = ['Only '.max($old, 0).' in stock.'];

                    continue;
                }
                $changed[$item['variant_id']] = [$old, $new];
            }

            if ($stale !== []) {
                throw new ApiException(409, 'stock_changed', 'Stock changed since you opened this. Check and try again.', $stale);
            }
            if ($insufficient !== []) {
                throw new ApiException(422, 'insufficient_stock', 'Not enough stock.', $insufficient);
            }

            $movements = [];
            foreach ($changed as $variantId => [$old, $new]) {
                if ($new === $old) {
                    continue;
                }
                $row = $rows[$variantId];
                $row->on_hand = $new;
                $row->save();
                WebhookEvents::stock($row, $old, $new);
                $movements[] = $this->movementRow($storeId, $variantId, $new - $old, $new, $reason, $note, $reference['type'] ?? null, $reference['id'] ?? null, $actorId);
            }
            $this->insertMovements($movements);

            $ids = array_column($movements, 'id');

            return [
                'inventories' => $rows,
                'movements' => $ids === [] ? [] : InventoryMovement::query()->whereIn('id', $ids)->orderBy('id')->get()->all(),
            ];
        });
    }

    /** @return array<string, mixed> */
    private function movementRow(string $storeId, string $variantId, int $delta, int $after, string $reason, ?string $note, ?string $refType, ?string $refId, ?string $actorId): array
    {
        return [
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $this->context->requireId(),
            'store_id' => $storeId,
            'variant_id' => $variantId,
            'delta' => $delta,
            'on_hand_after' => $after,
            'reason' => $reason,
            'note' => $note,
            'reference_type' => $refType,
            'reference_id' => $refId,
            'actor_user_id' => $actorId,
            'actor_api_key_id' => $actorId === null ? CurrentApiKey::current()?->id : null, // PHASE-8-4 §3
            'created_at' => now(),
        ];
    }

    /** @param list<array<string, mixed>> $rows */
    private function insertMovements(array $rows): void
    {
        foreach (array_chunk($rows, 200) as $chunk) {
            InventoryMovement::query()->insert($chunk);
        }
    }

    /**
     * Commits stock for a new order: all-or-nothing, under row locks in variant_id order. A line passes when
     * on_hand − committed ≥ quantity, or the variant allows backorders. Caller passes tracked variants only.
     *
     * @param  list<array{variant_id: string, quantity: int, allow_backorder: bool, field: string}>  $lines  field = error path
     *
     * @throws ApiException 422 out_of_stock with details[field] = ["Only N left."]
     */
    public function commit(string $storeId, array $lines): void
    {
        if ($lines === []) {
            return;
        }
        $rows = $this->lockRows($storeId, array_column($lines, 'variant_id'));

        $errors = [];
        $wanted = [];
        foreach ($lines as $line) {
            $wanted[$line['variant_id']] = ($wanted[$line['variant_id']] ?? 0) + $line['quantity'];
        }
        foreach ($lines as $line) {
            $row = $rows[$line['variant_id']] ?? null;
            $available = $row === null ? 0 : $row->on_hand - $row->committed;
            if (! $line['allow_backorder'] && $available < $wanted[$line['variant_id']]) {
                $errors[$line['field']] = [self::shortage($available)];
            }
        }
        if ($errors !== []) {
            throw new ApiException(422, 'out_of_stock', 'Some items are no longer available in that quantity.', $errors);
        }

        foreach ($wanted as $variantId => $quantity) {
            $row = $rows[$variantId] ?? null;
            if ($row === null) {
                continue; // backorder variant without an inventory row: nothing to hold
            }
            Inventory::query()->whereKey($row->id)->update(['committed' => DB::raw('committed + '.(int) $quantity), 'updated_at' => now()]);
        }
    }

    /**
     * Releases committed stock of an unshipped order (cancel). Never below zero: a merchant can't be blocked from
     * cancelling by drifted counters, so an underflow is clamped and logged.
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     */
    public function release(string $storeId, array $lines): void
    {
        if ($lines === []) {
            return;
        }
        $rows = $this->lockRows($storeId, array_column($lines, 'variant_id'));
        foreach ($this->sum($lines) as $variantId => $quantity) {
            $row = $rows[$variantId] ?? null;
            if ($row === null) {
                continue;
            }
            $next = $row->committed - $quantity;
            if ($next < 0) {
                Log::warning('inventory.release_underflow', ['variant_id' => $variantId, 'committed' => $row->committed, 'quantity' => $quantity]);
            }
            Inventory::query()->whereKey($row->id)->update(['committed' => max(0, $next), 'updated_at' => now()]);
        }
    }

    /**
     * Ships an order: on_hand and committed both decrease; one `order_shipped` ledger row per variant.
     *
     * @param  list<array{variant_id: string, quantity: int, field?: string}>  $lines
     *
     * @throws ApiException 422 insufficient_stock when on hand is below the shipped quantity
     */
    public function ship(string $storeId, array $lines, string $orderId, ?string $actorId): void
    {
        if ($lines === []) {
            return;
        }
        $rows = $this->lockRows($storeId, array_column($lines, 'variant_id'));
        $fields = array_column($lines, 'field', 'variant_id');
        $errors = [];
        $plan = [];
        foreach ($this->sum($lines) as $variantId => $quantity) {
            $row = $rows[$variantId] ?? null;
            if ($row === null) {
                continue; // variant hard-deleted: nothing left to move
            }
            $onHand = $row->on_hand - $quantity;
            $committed = $row->committed - $quantity;
            if ($committed < 0) {
                throw new LogicException("Shipping more than is committed for variant {$variantId}.");
            }
            if ($onHand < 0) {
                $errors[$fields[$variantId] ?? 'items'] = ['Only '.max($row->on_hand, 0).' in stock. Receive stock before shipping.'];

                continue;
            }
            $plan[$variantId] = [$row, $onHand, $committed, $quantity];
        }
        if ($errors !== []) {
            throw new ApiException(422, 'insufficient_stock', 'Not enough stock on hand to ship this order.', $errors);
        }

        $movements = [];
        foreach ($plan as $variantId => [$row, $onHand, $committed, $quantity]) {
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'committed' => $committed, 'updated_at' => now()]);
            WebhookEvents::stock($row, $row->on_hand, $onHand);
            $movements[] = $this->movementRow($storeId, $variantId, -$quantity, $onHand, 'order_shipped', null, 'order', $orderId, $actorId);
        }
        $this->insertMovements($movements);
    }

    /**
     * Puts returned units back on hand (ledger `order_returned`). The ledger reference is the order, or the given one
     * (5b-5: a return request, `['type' => 'return', 'id' => …]`).
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @param  array{type: string, id: string}|null  $reference
     */
    public function restock(string $storeId, array $lines, string $orderId, ?string $actorId, ?string $note = null, ?array $reference = null): void
    {
        $lines = array_values(array_filter($lines, fn (array $l) => $l['quantity'] > 0));
        if ($lines === []) {
            return;
        }
        $rows = $this->lockRows($storeId, array_column($lines, 'variant_id'));
        $movements = [];
        foreach ($this->sum($lines) as $variantId => $quantity) {
            $row = $rows[$variantId] ?? null;
            if ($row === null) {
                continue;
            }
            $onHand = $row->on_hand + $quantity;
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'updated_at' => now()]);
            $movements[] = $this->movementRow($storeId, $variantId, $quantity, $onHand, 'order_returned', $note, $reference['type'] ?? 'order', $reference['id'] ?? $orderId, $actorId);
        }
        $this->insertMovements($movements);
    }

    /** "Only 3 left." / "This item is sold out." (P5 out_of_stock details). */
    public static function shortage(int $available): string
    {
        return $available > 0 ? "Only {$available} left." : 'This item is sold out.';
    }

    /**
     * Inventory rows of the variants, locked FOR UPDATE in variant_id order (the fixed lock order of §7).
     *
     * @param  list<string>  $variantIds
     * @return array<string, Inventory>
     */
    private function lockRows(string $storeId, array $variantIds): array
    {
        $ids = array_values(array_unique($variantIds));
        sort($ids, SORT_STRING);

        return Inventory::query()->where('store_id', $storeId)->whereIn('variant_id', $ids)
            ->orderBy('variant_id')->lockForUpdate()->get()->keyBy('variant_id')->all();
    }

    /**
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @return array<string, int>
     */
    private function sum(array $lines): array
    {
        $out = [];
        foreach ($lines as $line) {
            $out[$line['variant_id']] = ($out[$line['variant_id']] ?? 0) + (int) $line['quantity'];
        }
        ksort($out, SORT_STRING);

        return $out;
    }
}
