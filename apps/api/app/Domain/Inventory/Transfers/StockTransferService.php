<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Location;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Inventory\Models\StockTransferItem;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Stock transfer lifecycle (PHASE-8-8C §7, P88C-9/10/18): draft → in_transit (send: `transfer_out` at the source) →
 * received (receive: `transfer_in` at the destination for the received units; the rest is short and written off,
 * never re-entering stock) ; cancelled from draft (no stock change) or in_transit (the sent units go back to the source,
 * `transfer_in`, note "Cancelled"). Every transition locks the transfer row FOR UPDATE first, then stock rows (§3.3),
 * honours the optional `revision` (409 `revision_conflict`) and audits. Wrong state → 409 `invalid_state_transition`.
 * The plan gate (`multi_warehouse`, P88C-13) runs in the Form Requests of create / update / send.
 */
final class StockTransferService
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly AuditLogger $audit,
    ) {}

    /** @param array<string, mixed> $input validated CreateStockTransferInput */
    public function create(Store $store, array $input, User $user): StockTransfer
    {
        return DB::transaction(function () use ($store, $input, $user) {
            [$from, $to] = $this->route($store, (string) $input['from_location_id'], (string) $input['to_location_id']);
            $lines = $this->resolveLines($store, $input['lines']);

            $transfer = new StockTransfer;
            $transfer->store_id = $store->id;
            $transfer->sequence = StoreCounter::next($store->id, StoreCounter::TRANSFERS);
            $transfer->number = StockTransfer::numberFor($transfer->sequence);
            $transfer->from_location_id = $from->id;
            $transfer->to_location_id = $to->id;
            $transfer->status = StockTransfer::DRAFT;
            $transfer->note = self::text($input['note'] ?? null);
            $transfer->revision = 1;
            $transfer->created_by = $user->id;
            $this->writeLines($store, $transfer, $lines);
            $this->audit->log('stock_transfer.created', $transfer, self::meta($transfer, $lines));

            if (($input['send'] ?? false) === true) {
                return $this->sendLocked($store, $transfer, $user);
            }

            return $transfer;
        });
    }

    /** @param array<string, mixed> $input validated UpdateStockTransferInput (partial + revision) */
    public function update(Store $store, StockTransfer $transfer, array $input, User $user): StockTransfer
    {
        return DB::transaction(function () use ($store, $transfer, $input) {
            $row = $this->lock($store, $transfer, (int) $input['revision'], [StockTransfer::DRAFT]);
            $changed = [];
            $fromId = array_key_exists('from_location_id', $input) ? (string) $input['from_location_id'] : $row->from_location_id;
            $toId = array_key_exists('to_location_id', $input) ? (string) $input['to_location_id'] : $row->to_location_id;
            if (strtolower($fromId) !== $row->from_location_id || strtolower($toId) !== $row->to_location_id) {
                [$from, $to] = $this->route($store, $fromId, $toId);
                if ($from->id !== $row->from_location_id) {
                    $changed[] = 'from_location_id';
                }
                if ($to->id !== $row->to_location_id) {
                    $changed[] = 'to_location_id';
                }
                $row->from_location_id = $from->id;
                $row->to_location_id = $to->id;
            }
            if (array_key_exists('note', $input) && self::text($input['note']) !== $row->note) {
                $row->note = self::text($input['note']);
                $changed[] = 'note';
            }
            $lines = null;
            if (array_key_exists('lines', $input)) {
                $lines = $this->resolveLines($store, $input['lines']);
                $current = StockTransferItem::query()->where('stock_transfer_id', $row->id)->orderBy('position')->get()
                    ->map(fn (StockTransferItem $i) => ['variant_id' => $i->variant_id, 'quantity' => $i->quantity])->values()->all();
                if ($current !== $lines) {
                    StockTransferItem::query()->where('stock_transfer_id', $row->id)->delete();
                    $changed[] = 'lines';
                } else {
                    $lines = null;
                }
            }
            if ($changed === []) {
                return $row;
            }
            $row->revision++;
            if ($lines !== null) {
                $this->writeLines($store, $row, $lines);
            } else {
                $row->save();
            }
            $this->audit->log('stock_transfer.updated', $row, self::meta($row, $this->lines($row)) + ['changed' => $changed]);

            return $row;
        });
    }

    public function delete(Store $store, StockTransfer $transfer): void
    {
        DB::transaction(function () use ($store, $transfer) {
            $row = $this->lock($store, $transfer, null, [StockTransfer::DRAFT]);
            $meta = self::meta($row, $this->lines($row));
            StockTransferItem::query()->where('stock_transfer_id', $row->id)->delete();
            $row->delete();
            $this->audit->log('stock_transfer.deleted', $row, $meta);
        });
    }

    public function send(Store $store, StockTransfer $transfer, ?int $revision, User $user): StockTransfer
    {
        return DB::transaction(function () use ($store, $transfer, $revision, $user) {
            return $this->sendLocked($store, $this->lock($store, $transfer, $revision, [StockTransfer::DRAFT]), $user);
        });
    }

    /**
     * @param  list<array{item_id: string, received: int}>  $input  one entry per line
     */
    public function receive(Store $store, StockTransfer $transfer, array $input, ?int $revision, User $user): StockTransfer
    {
        return DB::transaction(function () use ($store, $transfer, $input, $revision, $user) {
            $row = $this->lock($store, $transfer, $revision, [StockTransfer::IN_TRANSIT]);
            $to = $this->activeLocation($store, $row->to_location_id, 'to_location_id');
            $items = StockTransferItem::query()->where('stock_transfer_id', $row->id)->orderBy('position')->get()->keyBy('id');

            $received = [];
            $errors = [];
            foreach ($input as $i => $line) {
                $id = strtolower((string) $line['item_id']);
                $item = $items->get($id);
                if ($item === null) {
                    $errors["lines.{$i}.item_id"] = ['Unknown line.'];

                    continue;
                }
                if (isset($received[$id])) {
                    $errors["lines.{$i}.item_id"] = ['This line is listed twice.'];

                    continue;
                }
                if ((int) $line['received'] > $item->quantity) {
                    $errors["lines.{$i}.received"] = ["At most {$item->quantity} were sent."];

                    continue;
                }
                $received[$id] = (int) $line['received'];
            }
            if ($errors === [] && count($received) !== $items->count()) {
                $errors['lines'] = ['Enter the received quantity for every line.'];
            }
            if ($errors !== []) {
                throw ValidationException::withMessages($errors);
            }

            $in = [];
            $short = 0;
            $got = 0;
            foreach ($items as $id => $item) {
                $item->quantity_received = $received[$id];
                $item->save();
                $got += $received[$id];
                $short += $item->quantity - $received[$id];
                $in[] = ['variant_id' => $item->variant_id, 'quantity' => $received[$id]];
            }
            // Short units are only recorded on the transfer: they already left the source on send (no ledger row).
            $this->inventory->transferIn($store->id, $to->id, $in, $row->id, "{$row->number} → {$to->name}", $user->id);

            $row->status = StockTransfer::RECEIVED;
            $row->received_at = now();
            $row->received_by = $user->id;
            $row->units_received = $got;
            $row->units_short = $short;

            return $this->saveTransition($row, 'stock_transfer.received', ['units_received' => $got, 'units_short' => $short,
                'lines' => $items->map(fn (StockTransferItem $i) => ['variant_id' => $i->variant_id, 'quantity' => $i->quantity, 'received' => $i->quantity_received])->values()->all()]);
        });
    }

    public function cancel(Store $store, StockTransfer $transfer, ?int $revision, User $user): StockTransfer
    {
        return DB::transaction(function () use ($store, $transfer, $revision, $user) {
            $row = $this->lock($store, $transfer, $revision, StockTransfer::OPEN);
            $lines = $this->lines($row);
            $returned = 0;
            if ($row->status === StockTransfer::IN_TRANSIT) {
                // P88C-9: the sent units go back to the source exactly once (the row lock + status make it single-shot).
                $this->inventory->transferIn($store->id, $row->from_location_id, $lines, $row->id, "{$row->number} · Cancelled", $user->id);
                $returned = (int) array_sum(array_column($lines, 'quantity'));
            }
            $was = $row->status;
            $row->status = StockTransfer::CANCELLED;
            $row->cancelled_at = now();
            $row->cancelled_by = $user->id;

            return $this->saveTransition($row, 'stock_transfer.cancelled', ['from_status' => $was, 'units_returned' => $returned, 'lines' => $lines]);
        });
    }

    /**
     * The transfer row locked FOR UPDATE inside the store, with the optional revision check and the allowed statuses.
     *
     * @param  list<string>  $statuses
     */
    public function lock(Store $store, StockTransfer $transfer, ?int $revision, array $statuses): StockTransfer
    {
        /** @var StockTransfer $row */
        $row = StockTransfer::query()->where('store_id', $store->id)->whereKey($transfer->id)->lockForUpdate()->firstOrFail();
        if ($revision !== null && $revision !== $row->revision) {
            throw new ApiException(409, 'revision_conflict', 'This transfer changed since you opened it. Reload and try again.', ['revision' => $row->revision]);
        }
        if (! in_array($row->status, $statuses, true)) {
            throw new ApiException(409, 'invalid_state_transition', 'This transfer can’t do that in its current state.');
        }

        return $row;
    }

    /** P88C-10 send under the transfer row lock: both locations active, tracked variants, ≤ source available. */
    private function sendLocked(Store $store, StockTransfer $row, User $user): StockTransfer
    {
        $from = $this->activeLocation($store, $row->from_location_id, 'from_location_id');
        $to = $this->activeLocation($store, $row->to_location_id, 'to_location_id');
        $lines = $this->lines($row);
        $this->assertTracked($store, $lines);
        $this->inventory->transferOut($store->id, $from->id, $lines, $row->id, "{$row->number} → {$to->name}", $user->id);

        $row->status = StockTransfer::IN_TRANSIT;
        $row->sent_at = now();
        $row->sent_by = $user->id;
        $row->units_sent = (int) array_sum(array_column($lines, 'quantity'));

        return $this->saveTransition($row, 'stock_transfer.sent', ['lines' => $lines]);
    }

    /** @param array<string, mixed> $meta */
    private function saveTransition(StockTransfer $row, string $action, array $meta): StockTransfer
    {
        $row->revision++;
        $row->save();
        $this->audit->log($action, $row, self::meta($row) + $meta);

        return $row;
    }

    /** @return array{0: Location, 1: Location} */
    private function route(Store $store, string $fromId, string $toId): array
    {
        $from = Locations::resolve($store->id, $fromId, 'from_location_id');
        $to = Locations::resolve($store->id, $toId, 'to_location_id');
        if ($from->id === $to->id) {
            throw ValidationException::withMessages(['to_location_id' => ['Choose a different location to send to.']]);
        }

        return [$from, $to];
    }

    private function activeLocation(Store $store, string $id, string $field): Location
    {
        return Locations::resolve($store->id, $id, $field);
    }

    /**
     * Variants of the store (not deleted, product not deleted) that track stock (422 `variant_not_tracked`).
     *
     * @param  list<array<string, mixed>>  $lines
     * @return list<array{variant_id: string, quantity: int}>
     */
    private function resolveLines(Store $store, array $lines): array
    {
        $out = array_values(array_map(fn ($l) => ['variant_id' => strtolower((string) $l['variant_id']), 'quantity' => (int) $l['quantity']], $lines));
        $this->assertTracked($store, $out, 'lines');

        return $out;
    }

    /** @param list<array{variant_id: string, quantity: int}> $lines */
    private function assertTracked(Store $store, array $lines, string $field = 'lines'): void
    {
        $variants = ProductVariant::query()->where('store_id', $store->id)->whereIn('id', array_column($lines, 'variant_id'))
            ->whereHas('product')->get()->keyBy('id');
        $unknown = [];
        $untracked = [];
        foreach ($lines as $i => $line) {
            $variant = $variants->get($line['variant_id']);
            if ($variant === null) {
                $unknown["{$field}.{$i}.variant_id"] = ['Unknown product.'];
            } elseif (! $variant->track_inventory) {
                $untracked["{$field}.{$i}.variant_id"] = ['This product doesn’t track stock.'];
            }
        }
        if ($unknown !== []) {
            throw ValidationException::withMessages($unknown);
        }
        if ($untracked !== []) {
            throw new ApiException(422, 'variant_not_tracked', 'Some products don’t track stock.', $untracked);
        }
    }

    /** @param list<array{variant_id: string, quantity: int}> $lines */
    private function writeLines(Store $store, StockTransfer $transfer, array $lines): void
    {
        $transfer->items_count = count($lines);
        $transfer->units_sent = (int) array_sum(array_column($lines, 'quantity'));
        $transfer->save();
        foreach ($lines as $position => $line) {
            $item = new StockTransferItem;
            $item->store_id = $store->id;
            $item->stock_transfer_id = $transfer->id;
            $item->variant_id = $line['variant_id'];
            $item->quantity = $line['quantity'];
            $item->position = $position;
            $item->save();
        }
    }

    /** @return list<array{variant_id: string, quantity: int}> */
    private function lines(StockTransfer $transfer): array
    {
        return StockTransferItem::query()->where('stock_transfer_id', $transfer->id)->orderBy('position')->orderBy('id')->get()
            ->map(fn (StockTransferItem $i) => ['variant_id' => $i->variant_id, 'quantity' => $i->quantity])->values()->all();
    }

    /**
     * @param  list<array{variant_id: string, quantity: int}>|null  $lines
     * @return array<string, mixed>
     */
    private static function meta(StockTransfer $transfer, ?array $lines = null): array
    {
        $meta = [
            'number' => $transfer->number,
            'status' => $transfer->status,
            'from_location_id' => $transfer->from_location_id,
            'to_location_id' => $transfer->to_location_id,
        ];
        if ($lines !== null) {
            $meta['lines'] = $lines;
        }

        return $meta;
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
