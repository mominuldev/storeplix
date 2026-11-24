<?php

namespace App\Domain\Inventory;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Inventory\Locations\Locations;
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
 * Phase 8.8c (P88C-3, §3.3, §5.1): stock is one row per variant PER LOCATION. Every item/line may carry a
 * `location_id`; omitted = the store's default location (= the online location). A missing row is created on the
 * first stock that goes there (threshold copied from the variant's default-location row). Every ledger row carries
 * its location. Rows are locked with SELECT … FOR UPDATE in (variant_id, location_id) order, so parallel requests
 * never deadlock.
 *
 * adjust(): one transaction; all-or-nothing; never negative; one ledger row per changed stock row; zero delta writes
 * nothing.
 *
 * Orders (ADR 0011): commit() at placement adds to `committed` (no ledger row), release() on cancel gives it back,
 * ship() moves the quantity out of both on_hand and committed (ledger `order_shipped`), restock() puts returned units
 * back on hand (ledger `order_returned`). Order lines carry the location their stock was committed at (P88C-4); the
 * callers pass it, so changing the online location never moves committed stock. They run inside the caller's order
 * transaction and use the same lock order.
 */
class InventoryService
{
    public function __construct(private readonly TenantContext $context) {}

    /**
     * Creates the inventory row of a NEW variant (always, also when untracked) plus an `initial` movement, at the
     * given location (default location when null). Must run inside the caller's transaction.
     */
    public function createFor(ProductVariant $variant, int $initialOnHand = 0, ?int $threshold = null, ?string $actorId = null, ?string $locationId = null): Inventory
    {
        $locationId ??= Locations::defaultId($variant->store_id);
        $inventory = new Inventory(['low_stock_threshold' => $threshold]);
        $inventory->store_id = $variant->store_id;
        $inventory->variant_id = $variant->id;
        $inventory->location_id = $locationId;
        $inventory->on_hand = $initialOnHand;
        $inventory->save();

        if ($initialOnHand !== 0) {
            $this->insertMovements([$this->movementRow($variant->store_id, $variant->id, $locationId, $initialOnHand, $initialOnHand, 'initial', null, null, null, $actorId)]);
        }

        return $inventory;
    }

    /**
     * Bulk variant of createFor() for imports: multi-row inserts at the store's default location (or the row's
     * `location_id`). $rows: [variant_id, store_id, on_hand, threshold, location_id?].
     *
     * @param  list<array{variant_id: string, store_id: string, on_hand: int, threshold: int|null, location_id?: string|null}>  $rows
     * @param  array{type: string, id: string}|null  $reference
     */
    public function createMany(array $rows, string $reason, ?array $reference, ?string $actorId): void
    {
        if ($rows === []) {
            return;
        }
        $tenantId = $this->context->requireId();
        $now = now();
        $defaults = [];
        $inventories = [];
        $movements = [];
        foreach ($rows as $row) {
            $locationId = $row['location_id'] ?? ($defaults[$row['store_id']] ??= Locations::defaultId($row['store_id']));
            $inventories[] = [
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $tenantId,
                'store_id' => $row['store_id'],
                'variant_id' => $row['variant_id'],
                'location_id' => $locationId,
                'on_hand' => $row['on_hand'],
                'committed' => 0,
                'low_stock_threshold' => $row['threshold'],
                'created_at' => $now,
                'updated_at' => $now,
            ];
            if ($row['on_hand'] !== 0) {
                $movements[] = $this->movementRow($row['store_id'], $row['variant_id'], $locationId, $row['on_hand'], $row['on_hand'], $reason, null, $reference['type'] ?? null, $reference['id'] ?? null, $actorId);
            }
        }
        foreach (array_chunk($inventories, 200) as $chunk) {
            Inventory::query()->insert($chunk);
        }
        $this->insertMovements($movements);
    }

    /**
     * @param  list<array{variant_id: string, mode: string, quantity: int, expected_on_hand?: int|null, location_id?: string|null}>  $items
     *                                                                                                                                       variant ids (and location ids) already checked against the store
     * @param  array{type: string, id: string}|null  $reference
     * @return array{inventories: array<string, Inventory>, movements: list<InventoryMovement>} inventories keyed by variant id (the item's row)
     */
    public function adjust(string $storeId, string $reason, ?string $note, array $items, ?string $actorId, ?array $reference = null): array
    {
        return DB::transaction(function () use ($storeId, $reason, $note, $items, $actorId, $reference) {
            $default = null;
            foreach ($items as $i => $item) {
                $items[$i]['location_id'] = ($item['location_id'] ?? null) ?: ($default ??= Locations::defaultId($storeId));
            }
            // A missing row is created on the first stock that goes there (P88C-3); rolled back if the adjust fails.
            $grow = array_values(array_filter($items, fn (array $item) => (int) $item['quantity'] > 0));
            $this->ensureRows($storeId, $grow);
            $rows = $this->lockRows($storeId, $items);

            $changed = [];
            $stale = [];
            $insufficient = [];
            foreach ($items as $i => $item) {
                $key = self::key($item['variant_id'], $item['location_id']);
                $row = $rows[$key] ?? null;
                $old = $row?->on_hand ?? 0;
                if (array_key_exists('expected_on_hand', $item) && $item['expected_on_hand'] !== null && (int) $item['expected_on_hand'] !== $old) {
                    $stale["items.{$i}.expected_on_hand"] = ["Stock changed to {$old} since you opened this. Check and try again."];

                    continue;
                }
                $new = $item['mode'] === 'set' ? (int) $item['quantity'] : $old + (int) $item['quantity'];
                if ($new < 0) {
                    $insufficient["items.{$i}.quantity"] = ['Only '.max($old, 0).' in stock.'];

                    continue;
                }
                if ($row === null && $new !== 0) {
                    throw new ApiException(422, 'validation_failed', 'The given data was invalid.', ["items.{$i}.variant_id" => ['Unknown variant.']]);
                }
                $changed[$key] = [$old, $new];
            }

            if ($stale !== []) {
                throw new ApiException(409, 'stock_changed', 'Stock changed since you opened this. Check and try again.', $stale);
            }
            if ($insufficient !== []) {
                throw new ApiException(422, 'insufficient_stock', 'Not enough stock.', $insufficient);
            }

            $movements = [];
            foreach ($changed as $key => [$old, $new]) {
                if ($new === $old) {
                    continue;
                }
                $row = $rows[$key];
                $row->on_hand = $new;
                $row->save();
                WebhookEvents::stock($row, $old, $new);
                $movements[] = $this->movementRow($storeId, $row->variant_id, $row->location_id, $new - $old, $new, $reason, $note, $reference['type'] ?? null, $reference['id'] ?? null, $actorId);
            }
            $this->insertMovements($movements);

            $byVariant = [];
            foreach ($items as $item) {
                $row = $rows[self::key($item['variant_id'], $item['location_id'])] ?? null;
                if ($row !== null) {
                    $byVariant[$item['variant_id']] = $row;
                }
            }
            $ids = array_column($movements, 'id');

            return [
                'inventories' => $byVariant,
                'movements' => $ids === [] ? [] : InventoryMovement::query()->whereIn('id', $ids)->orderBy('id')->get()->all(),
            ];
        });
    }

    /** @return array<string, mixed> */
    private function movementRow(string $storeId, string $variantId, string $locationId, int $delta, int $after, string $reason, ?string $note, ?string $refType, ?string $refId, ?string $actorId): array
    {
        return [
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $this->context->requireId(),
            'store_id' => $storeId,
            'variant_id' => $variantId,
            'location_id' => $locationId,
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
     * Commits stock for a new order: all-or-nothing, under row locks in (variant_id, location_id) order. A line passes
     * when on_hand − committed ≥ quantity AT ITS LOCATION, or the variant allows backorders. Caller passes tracked
     * variants only, each with the `location_id` it sells from (the online location, P88C-4; default when omitted).
     *
     * @param  list<array{variant_id: string, quantity: int, allow_backorder: bool, field: string, location_id?: string|null}>  $lines  field = error path
     *
     * @throws ApiException 422 out_of_stock with details[field] = ["Only N left."]
     */
    public function commit(string $storeId, array $lines): void
    {
        if ($lines === []) {
            return;
        }
        $lines = $this->withLocations($storeId, $lines);
        // Backorder lines may commit at a location that never held the variant: give them a row to hold it on.
        $this->ensureRows($storeId, array_values(array_filter($lines, fn (array $l) => $l['allow_backorder'])));
        $rows = $this->lockRows($storeId, $lines);

        $errors = [];
        $wanted = [];
        foreach ($lines as $line) {
            $key = self::key($line['variant_id'], $line['location_id']);
            $wanted[$key] = ($wanted[$key] ?? 0) + $line['quantity'];
        }
        foreach ($lines as $line) {
            $key = self::key($line['variant_id'], $line['location_id']);
            $row = $rows[$key] ?? null;
            $available = $row === null ? 0 : $row->on_hand - $row->committed;
            if (! $line['allow_backorder'] && $available < $wanted[$key]) {
                $errors[$line['field']] = [self::shortage($available)];
            }
        }
        if ($errors !== []) {
            throw new ApiException(422, 'out_of_stock', 'Some items are no longer available in that quantity.', $errors);
        }

        ksort($wanted, SORT_STRING);
        foreach ($wanted as $key => $quantity) {
            $row = $rows[$key] ?? null;
            if ($row === null) {
                continue; // variant hard-deleted meanwhile: nothing to hold
            }
            Inventory::query()->whereKey($row->id)->update(['committed' => DB::raw('committed + '.(int) $quantity), 'updated_at' => now()]);
        }
    }

    /**
     * Releases committed stock of an unshipped order (cancel) at each line's stored location. Never below zero: a
     * merchant can't be blocked from cancelling by drifted counters, so an underflow is clamped and logged.
     *
     * @param  list<array{variant_id: string, quantity: int, location_id?: string|null}>  $lines
     */
    public function release(string $storeId, array $lines): void
    {
        if ($lines === []) {
            return;
        }
        $lines = $this->withLocations($storeId, $lines);
        $rows = $this->lockRows($storeId, $lines);
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key] ?? null;
            if ($row === null) {
                continue;
            }
            $next = $row->committed - $quantity;
            if ($next < 0) {
                Log::warning('inventory.release_underflow', ['variant_id' => $row->variant_id, 'location_id' => $row->location_id, 'committed' => $row->committed, 'quantity' => $quantity]);
            }
            Inventory::query()->whereKey($row->id)->update(['committed' => max(0, $next), 'updated_at' => now()]);
        }
    }

    /**
     * Ships an order: on_hand and committed both decrease at each line's stored location; one `order_shipped` ledger
     * row per stock row.
     *
     * @param  list<array{variant_id: string, quantity: int, field?: string, location_id?: string|null}>  $lines
     *
     * @throws ApiException 422 insufficient_stock when on hand is below the shipped quantity
     */
    public function ship(string $storeId, array $lines, string $orderId, ?string $actorId): void
    {
        if ($lines === []) {
            return;
        }
        $lines = $this->withLocations($storeId, $lines);
        $rows = $this->lockRows($storeId, $lines);
        $fields = [];
        foreach ($lines as $line) {
            $fields[self::key($line['variant_id'], $line['location_id'])] = $line['field'] ?? 'items';
        }
        $errors = [];
        $plan = [];
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key] ?? null;
            if ($row === null) {
                continue; // variant hard-deleted: nothing left to move
            }
            $onHand = $row->on_hand - $quantity;
            $committed = $row->committed - $quantity;
            if ($committed < 0) {
                throw new LogicException("Shipping more than is committed for variant {$row->variant_id} at location {$row->location_id}.");
            }
            if ($onHand < 0) {
                $errors[$fields[$key] ?? 'items'] = ['Only '.max($row->on_hand, 0).' in stock. Receive stock before shipping.'];

                continue;
            }
            $plan[$key] = [$row, $onHand, $committed, $quantity];
        }
        if ($errors !== []) {
            throw new ApiException(422, 'insufficient_stock', 'Not enough stock on hand to ship this order.', $errors);
        }

        $movements = [];
        foreach ($plan as [$row, $onHand, $committed, $quantity]) {
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'committed' => $committed, 'updated_at' => now()]);
            WebhookEvents::stock($row, $row->on_hand, $onHand);
            $movements[] = $this->movementRow($storeId, $row->variant_id, $row->location_id, -$quantity, $onHand, 'order_shipped', null, 'order', $orderId, $actorId);
        }
        $this->insertMovements($movements);
    }

    /**
     * Puts returned units back on hand at each line's stored location (ledger `order_returned`, P88C-16). The ledger
     * reference is the order, or the given one (5b-5: a return request, `['type' => 'return', 'id' => …]`).
     *
     * @param  list<array{variant_id: string, quantity: int, location_id?: string|null}>  $lines
     * @param  array{type: string, id: string}|null  $reference
     */
    public function restock(string $storeId, array $lines, string $orderId, ?string $actorId, ?string $note = null, ?array $reference = null): void
    {
        $lines = array_values(array_filter($lines, fn (array $l) => $l['quantity'] > 0));
        if ($lines === []) {
            return;
        }
        $lines = $this->withLocations($storeId, $lines);
        $this->ensureRows($storeId, $lines);
        $rows = $this->lockRows($storeId, $lines);
        $movements = [];
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key] ?? null;
            if ($row === null) {
                continue;
            }
            $onHand = $row->on_hand + $quantity;
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'updated_at' => now()]);
            $movements[] = $this->movementRow($storeId, $row->variant_id, $row->location_id, $quantity, $onHand, 'order_returned', $note, $reference['type'] ?? 'order', $reference['id'] ?? $orderId, $actorId);
        }
        $this->insertMovements($movements);
    }

    /**
     * Transfer send (PHASE-8-8C §7, P88C-10): takes each line out of the source location in one go, ledger reason
     * `transfer_out`. Every line must fit the source's AVAILABLE stock (on_hand − committed) under the row locks, so a
     * transfer never takes stock already promised to an order; else 422 `insufficient_stock` with `details.lines`
     * ({variant_id, requested, available}) and nothing changes. Runs inside the caller's transaction (the transfer row
     * is locked first, §3.3).
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines  one per variant
     * @return list<InventoryMovement>
     */
    public function transferOut(string $storeId, string $locationId, array $lines, string $transferId, ?string $note, ?string $actorId): array
    {
        $lines = array_map(fn (array $l) => ['variant_id' => $l['variant_id'], 'quantity' => (int) $l['quantity'], 'location_id' => $locationId], $lines);
        $rows = $this->lockRows($storeId, $lines);
        $short = [];
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key] ?? null;
            $available = $row === null ? 0 : max(0, $row->on_hand - $row->committed);
            if ($quantity > $available) {
                $short[] = ['variant_id' => explode('|', $key)[0], 'requested' => $quantity, 'available' => $available];
            }
        }
        if ($short !== []) {
            throw new ApiException(422, 'insufficient_stock', 'Not enough stock at the source location for some lines.', ['lines' => $short]);
        }

        $movements = [];
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key];
            $onHand = $row->on_hand - $quantity;
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'updated_at' => now()]);
            WebhookEvents::stock($row, $row->on_hand, $onHand);
            $movements[] = $this->movementRow($storeId, $row->variant_id, $row->location_id, -$quantity, $onHand, 'transfer_out', $note, 'stock_transfer', $transferId, $actorId);
        }
        $this->insertMovements($movements);

        return $this->movementsOf($movements);
    }

    /**
     * Transfer receive / cancel-in-transit (PHASE-8-8C §7, P88C-9): puts units in at a location (the destination, or
     * the source again on cancel), ledger reason `transfer_in`. Missing rows are created (P88C-3). Lines with 0 are
     * skipped. Runs inside the caller's transaction.
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @return list<InventoryMovement>
     */
    public function transferIn(string $storeId, string $locationId, array $lines, string $transferId, ?string $note, ?string $actorId): array
    {
        $lines = array_values(array_filter(
            array_map(fn (array $l) => ['variant_id' => $l['variant_id'], 'quantity' => (int) $l['quantity'], 'location_id' => $locationId], $lines),
            fn (array $l) => $l['quantity'] > 0,
        ));
        if ($lines === []) {
            return [];
        }
        $this->ensureRows($storeId, $lines);
        $rows = $this->lockRows($storeId, $lines);
        $movements = [];
        foreach ($this->sum($lines) as $key => $quantity) {
            $row = $rows[$key] ?? null;
            if ($row === null) {
                continue;
            }
            $onHand = $row->on_hand + $quantity;
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $onHand, 'updated_at' => now()]);
            WebhookEvents::stock($row, $row->on_hand, $onHand);
            $movements[] = $this->movementRow($storeId, $row->variant_id, $row->location_id, $quantity, $onHand, 'transfer_in', $note, 'stock_transfer', $transferId, $actorId);
        }
        $this->insertMovements($movements);

        return $this->movementsOf($movements);
    }

    /**
     * Stock count finish (PHASE-8-8C §8, P88C-11): ONE call that applies, at one location, either a `delta` (counted −
     * expected-at-count) or `zero` (uncounted line with "Set uncounted items to 0": delta = −on_hand now) per line,
     * reason `count`, reference the count. Rows locked in (variant_id, location_id) order. on_hand never goes below 0
     * (a larger loss is clamped and the applied delta says so). Zero deltas write nothing. Runs inside the caller's
     * transaction (the count row is locked first, §3.3).
     *
     * @param  list<array{variant_id: string, delta?: int, zero?: bool}>  $lines  one per variant
     * @return array<string, int> applied delta per variant id (non-zero only)
     */
    public function applyCount(string $storeId, string $locationId, array $lines, string $countId, ?string $note, ?string $actorId): array
    {
        $lines = array_map(fn (array $l) => $l + ['location_id' => $locationId], $lines);
        if ($lines === []) {
            return [];
        }
        $this->ensureRows($storeId, array_values(array_filter($lines, fn (array $l) => (int) ($l['delta'] ?? 0) > 0)));
        $rows = $this->lockRows($storeId, $lines);
        usort($lines, fn (array $a, array $b) => strcmp($a['variant_id'], $b['variant_id']));

        $applied = [];
        $movements = [];
        foreach ($lines as $line) {
            $row = $rows[self::key($line['variant_id'], $locationId)] ?? null;
            if ($row === null) {
                continue; // nothing there and nothing to add
            }
            $old = $row->on_hand;
            $new = ($line['zero'] ?? false) ? 0 : max(0, $old + (int) ($line['delta'] ?? 0));
            if ($new === $old) {
                continue;
            }
            Inventory::query()->whereKey($row->id)->update(['on_hand' => $new, 'updated_at' => now()]);
            WebhookEvents::stock($row, $old, $new);
            $movements[] = $this->movementRow($storeId, $row->variant_id, $locationId, $new - $old, $new, 'count', $note, 'stock_count', $countId, $actorId);
            $applied[$row->variant_id] = $new - $old;
        }
        $this->insertMovements($movements);

        return $applied;
    }

    /**
     * @param  list<array<string, mixed>>  $rows  movement rows just inserted
     * @return list<InventoryMovement>
     */
    private function movementsOf(array $rows): array
    {
        $ids = array_column($rows, 'id');

        return $ids === [] ? [] : InventoryMovement::query()->whereIn('id', $ids)->orderBy('id')->get()->all();
    }

    /** "Only 3 left." / "This item is sold out." (P5 out_of_stock details). */
    public static function shortage(int $available): string
    {
        return $available > 0 ? "Only {$available} left." : 'This item is sold out.';
    }

    /**
     * Locks every stock row of the variants at ALL their locations, in (variant_id, location_id) order (§3.3:
     * weighted-average receive reads total on hand under these locks). @param list<string> $variantIds
     *
     * @return list<Inventory>
     */
    public function lockAllRows(string $storeId, array $variantIds): array
    {
        $ids = array_values(array_unique($variantIds));
        if ($ids === []) {
            return [];
        }
        sort($ids, SORT_STRING);

        return Inventory::query()->where('store_id', $storeId)->whereIn('variant_id', $ids)
            ->orderBy('variant_id')->orderBy('location_id')->lockForUpdate()->get()->all();
    }

    /**
     * Inventory rows of the (variant, location) pairs, locked FOR UPDATE in (variant_id, location_id) order (§3.3),
     * keyed "variant_id|location_id". Pairs need a `location_id`.
     *
     * @param  list<array{variant_id: string, location_id: string}>  $pairs
     * @return array<string, Inventory>
     */
    public function lockRows(string $storeId, array $pairs): array
    {
        $variantIds = array_values(array_unique(array_column($pairs, 'variant_id')));
        $locationIds = array_values(array_unique(array_column($pairs, 'location_id')));
        if ($variantIds === []) {
            return [];
        }
        sort($variantIds, SORT_STRING);
        sort($locationIds, SORT_STRING);
        $wanted = [];
        foreach ($pairs as $pair) {
            $wanted[self::key($pair['variant_id'], $pair['location_id'])] = true;
        }

        $out = [];
        foreach (Inventory::query()->where('store_id', $storeId)->whereIn('variant_id', $variantIds)->whereIn('location_id', $locationIds)
            ->orderBy('variant_id')->orderBy('location_id')->lockForUpdate()->get() as $row) {
            $key = self::key($row->variant_id, $row->location_id);
            if (isset($wanted[$key])) {
                $out[$key] = $row;
            }
        }

        return $out;
    }

    /**
     * Creates the missing (variant, location) rows with on_hand 0 (P88C-3), threshold copied from the variant's
     * default-location row. INSERT … ON CONFLICT DO NOTHING: concurrent creators can't fail each other.
     *
     * @param  list<array{variant_id: string, location_id?: string|null}>  $pairs
     */
    private function ensureRows(string $storeId, array $pairs): void
    {
        if ($pairs === []) {
            return;
        }
        $pairs = $this->withLocations($storeId, $pairs);
        $variantIds = array_values(array_unique(array_column($pairs, 'variant_id')));
        $existing = [];
        foreach (Inventory::query()->where('store_id', $storeId)->whereIn('variant_id', $variantIds)->get(['variant_id', 'location_id', 'low_stock_threshold']) as $row) {
            $existing[self::key($row->variant_id, $row->location_id)] = true;
        }
        $missing = [];
        foreach ($pairs as $pair) {
            $key = self::key($pair['variant_id'], $pair['location_id']);
            if (! isset($existing[$key])) {
                $missing[$key] = $pair;
            }
        }
        if ($missing === []) {
            return;
        }
        $thresholds = Inventory::query()->online()->where('store_id', $storeId)
            ->whereIn('variant_id', array_values(array_unique(array_column($missing, 'variant_id'))))->pluck('low_stock_threshold', 'variant_id')->all();
        $tenantId = $this->context->requireId();
        $now = now();
        $insert = [];
        foreach ($missing as $pair) {
            $insert[] = [
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $tenantId,
                'store_id' => $storeId,
                'variant_id' => $pair['variant_id'],
                'location_id' => $pair['location_id'],
                'on_hand' => 0,
                'committed' => 0,
                'low_stock_threshold' => $thresholds[$pair['variant_id']] ?? null,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        Inventory::query()->insertOrIgnore($insert);
    }

    /**
     * Fills a missing `location_id` with the store's default location.
     *
     * @template T of array
     *
     * @param  list<T>  $lines
     * @return list<T>
     */
    private function withLocations(string $storeId, array $lines): array
    {
        $default = null;
        foreach ($lines as $i => $line) {
            if (($line['location_id'] ?? null) === null || $line['location_id'] === '') {
                $lines[$i]['location_id'] = $default ??= Locations::defaultId($storeId);
            }
        }

        return $lines;
    }

    private static function key(string $variantId, string $locationId): string
    {
        return $variantId.'|'.$locationId;
    }

    /**
     * @param  list<array{variant_id: string, quantity: int, location_id: string}>  $lines
     * @return array<string, int> keyed "variant_id|location_id", sorted (lock order)
     */
    private function sum(array $lines): array
    {
        $out = [];
        foreach ($lines as $line) {
            $key = self::key($line['variant_id'], $line['location_id']);
            $out[$key] = ($out[$key] ?? 0) + (int) $line['quantity'];
        }
        ksort($out, SORT_STRING);

        return $out;
    }
}
