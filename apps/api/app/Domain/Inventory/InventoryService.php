<?php

namespace App\Domain\Inventory;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The ONLY writer of inventories.on_hand and inventory_movements (P4-12, P4-13).
 *
 * adjust(): one transaction; rows are locked with SELECT … FOR UPDATE in variant_id order (no deadlocks between
 * parallel requests); all-or-nothing; never negative; one ledger row per changed variant; zero delta writes nothing.
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
}
