<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Http\Resources\StockVariantPresenter;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Inventory\Models\StockTransferItem;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/** `StockTransfer`, `StockTransferDetail`, `StockTransferSummary` payloads (@storeplix/types, PHASE-8-8C §7). */
final class StockTransferPresenter
{
    /** Audit actions shown as events (no `updated`). */
    private const EVENTS = [
        'stock_transfer.created' => 'created', 'stock_transfer.sent' => 'sent',
        'stock_transfer.received' => 'received', 'stock_transfer.cancelled' => 'cancelled',
    ];

    /**
     * @param  Collection<int, StockTransfer>  $transfers
     * @return list<array<string, mixed>>
     */
    public static function many(Collection $transfers): array
    {
        $transfers->loadMissing(['fromLocation', 'toLocation', 'createdBy']);

        return $transfers->map(fn (StockTransfer $t) => self::one($t))->values()->all();
    }

    /** @return array<string, mixed> StockTransfer (fromLocation, toLocation, createdBy loaded or lazy) */
    public static function one(StockTransfer $t): array
    {
        return [
            'id' => $t->id,
            'number' => $t->number,
            'status' => $t->status,
            'from_location' => ['id' => $t->from_location_id, 'name' => (string) $t->fromLocation?->name],
            'to_location' => ['id' => $t->to_location_id, 'name' => (string) $t->toLocation?->name],
            'note' => $t->note,
            'items_count' => $t->items_count,
            'units_sent' => $t->units_sent,
            'units_received' => $t->status === StockTransfer::RECEIVED ? $t->units_received : null,
            'units_short' => $t->status === StockTransfer::RECEIVED ? $t->units_short : 0,
            'created_by' => UserRef::of($t->createdBy),
            'sent_at' => UserRef::iso($t->sent_at),
            'received_at' => UserRef::iso($t->received_at),
            'cancelled_at' => UserRef::iso($t->cancelled_at),
            'created_at' => UserRef::iso($t->created_at),
            'updated_at' => UserRef::iso($t->updated_at),
            'revision' => $t->revision,
        ];
    }

    /** @return array<string, mixed> StockTransferDetail */
    public static function detail(StockTransfer $t): array
    {
        $t->load(['fromLocation', 'toLocation', 'createdBy']);
        $items = StockTransferItem::query()->where('stock_transfer_id', $t->id)->with(StockVariantPresenter::paths())
            ->orderBy('position')->orderBy('id')->get();
        $source = Inventory::query()->where('store_id', $t->store_id)->where('location_id', $t->from_location_id)
            ->whereIn('variant_id', $items->pluck('variant_id')->all())->get()->keyBy('variant_id');

        $lines = $items->map(function (StockTransferItem $i) use ($source) {
            /** @var Inventory|null $row */
            $row = $source->get($i->variant_id);

            return [
                'id' => $i->id,
                'variant' => StockVariantPresenter::ref($i->variant, $i->variant_id),
                'quantity' => $i->quantity,
                'quantity_received' => $i->quantity_received,
                'source_on_hand' => $row?->on_hand ?? 0,
                'source_available' => $row === null ? 0 : $row->on_hand - $row->committed,
                'source_low_stock_threshold' => $row?->low_stock_threshold,
                'position' => $i->position,
            ];
        })->values()->all();

        return self::one($t) + ['lines' => $lines, 'events' => self::events($t)];
    }

    /** @return array<string, mixed> StockTransferSummary */
    public static function summary(Store $store): array
    {
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $monthStart = CarbonImmutable::now($tz)->startOfMonth()->utc();
        $base = fn () => StockTransfer::query()->where('store_id', $store->id);
        $locations = Locations::active($store->id);

        return [
            'drafts_count' => $base()->where('status', StockTransfer::DRAFT)->count(),
            'in_transit_count' => $base()->where('status', StockTransfer::IN_TRANSIT)->count(),
            'in_transit_units' => (int) $base()->where('status', StockTransfer::IN_TRANSIT)->sum('units_sent'),
            'last_sent_at' => UserRef::iso(($v = $base()->whereNotNull('sent_at')->max('sent_at')) === null ? null : CarbonImmutable::parse($v)),
            'received_this_month_count' => $base()->where('status', StockTransfer::RECEIVED)->where('received_at', '>=', $monthStart)->count(),
            'received_this_month_units' => (int) $base()->where('status', StockTransfer::RECEIVED)->where('received_at', '>=', $monthStart)->sum('units_received'),
            'locations' => ['count' => count($locations), 'names' => array_map(fn ($l) => $l->name, $locations)],
        ];
    }

    /** @return list<array<string, mixed>> StockTransferEvent, oldest first */
    private static function events(StockTransfer $t): array
    {
        $rows = AuditLog::query()->where('tenant_id', $t->tenant_id)->where('subject_type', 'stock_transfer')->where('subject_id', $t->id)
            ->whereIn('action', array_keys(self::EVENTS))->orderBy('created_at')->orderBy('id')->get()
            // create-and-send writes both in one instant: keep the lifecycle order on ties.
            ->sortBy([fn (AuditLog $a, AuditLog $b) => [$a->created_at->getTimestampMs(), array_search($a->action, array_keys(self::EVENTS), true)]
                <=> [$b->created_at->getTimestampMs(), array_search($b->action, array_keys(self::EVENTS), true)]])->values();
        $users = User::query()->whereIn('id', $rows->where('actor_type', 'user')->pluck('actor_id')->filter()->unique()->values())->get()->keyBy('id');

        return $rows->map(fn (AuditLog $row) => [
            'type' => self::EVENTS[$row->action],
            'actor' => $row->actor_type === 'user' ? UserRef::of($users->get($row->actor_id)) : null,
            'created_at' => UserRef::iso($row->created_at),
        ])->values()->all();
    }
}
