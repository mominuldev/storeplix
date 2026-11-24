<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Locations;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\Location;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Location writes (PHASE-8-8C §4, P88C-2/5/13/17/18). Validated input is mapped field by field (tenant_id, store_id,
 * is_default, position, created_by never come from the body). Every write locks the store row, then the store's
 * location rows (FOR UPDATE), so the 10-location cap, the plan check and the single default can't be raced. Every write audited.
 *
 * Plan (P88C-13, Q227/Q228): creating or unarchiving a location while the store already has ≥ 1 active location
 * needs `multi_warehouse` (402 `feature_not_in_plan`); edit, archive and make-default work on every plan.
 */
final class LocationService
{
    public const DUPLICATE_NAME = 'You already have a location with this name.';

    public const PO_STATUSES = [PurchaseOrder::DRAFT, PurchaseOrder::ORDERED, PurchaseOrder::PARTIALLY_RECEIVED];

    public function __construct(
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /** @param array<string, mixed> $input validated LocationInput */
    public function create(Store $store, array $input, ?User $user): Location
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $input, $user) {
            $rows = $this->lockAll($store);
            $this->assertCanAddActive($rows);

            $location = new Location;
            $location->store_id = $store->id;
            $location->type = 'warehouse';
            $this->fill($store, $location, $input);
            $location->is_default = false;
            $location->position = (int) (collect($rows)->max('position') ?? 0) + 1;
            $location->created_by = $user?->id;
            $this->assertNameFree($store, $location);
            $location->save();
            $this->audit->log('location.created', $location, ['name' => $location->name, 'type' => $location->type]);

            return $location;
        }));
    }

    /** @param array<string, mixed> $input partial LocationInput */
    public function update(Store $store, Location $location, array $input): Location
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $location, $input) {
            $this->lockAll($store);
            /** @var Location $row */
            $row = Location::query()->where('store_id', $store->id)->whereKey($location->id)->firstOrFail();
            $this->fill($store, $row, $input);
            if (! $row->isDirty()) {
                return $row;
            }
            $changed = array_values(array_diff(array_keys($row->getDirty()), ['updated_at']));
            if ($row->isDirty('name')) {
                $this->assertNameFree($store, $row);
            }
            $row->save();
            $this->audit->log('location.updated', $row, ['name' => $row->name, 'changed' => $changed]);

            return $row;
        }));
    }

    public function archive(Store $store, Location $location): Location
    {
        return DB::transaction(function () use ($store, $location) {
            $this->lockAll($store);
            /** @var Location $row */
            $row = Location::query()->where('store_id', $store->id)->whereKey($location->id)->firstOrFail();
            if ($row->isArchived()) {
                return $row;
            }
            $reasons = $this->archiveBlockers($store, $row);
            if ($reasons !== []) {
                throw new ApiException(409, 'location_in_use', self::blockedMessage($reasons), ['reasons' => $reasons]);
            }
            $row->archived_at = now();
            $row->save();
            $this->audit->log('location.archived', $row, ['name' => $row->name]);

            return $row;
        });
    }

    public function unarchive(Store $store, Location $location): Location
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $location) {
            $rows = $this->lockAll($store);
            /** @var Location $row */
            $row = Location::query()->where('store_id', $store->id)->whereKey($location->id)->firstOrFail();
            if (! $row->isArchived()) {
                return $row;
            }
            $this->assertCanAddActive($rows);
            $row->archived_at = null;
            $this->assertNameFree($store, $row);
            $row->save();
            $this->audit->log('location.unarchived', $row, ['name' => $row->name]);

            return $row;
        }));
    }

    /**
     * P88C-5: the location becomes the default = online location. Storefront availability switches at once; open
     * orders keep their lines' stored location. An archived location → 422 `location_archived`.
     */
    public function makeDefault(Store $store, Location $location): Location
    {
        return DB::transaction(function () use ($store, $location) {
            $this->lockAll($store);
            /** @var Location $row */
            $row = Location::query()->where('store_id', $store->id)->whereKey($location->id)->firstOrFail();
            if ($row->is_default) {
                return $row;
            }
            if ($row->isArchived()) {
                throw new ApiException(422, 'location_archived', 'Unarchive this location before making it the default.', ['location_id' => ["{$row->name} is archived."]]);
            }
            /** @var Location|null $previous */
            $previous = Location::query()->where('store_id', $store->id)->where('is_default', true)->first();
            if ($previous !== null) {
                $previous->is_default = false;
                $previous->save(); // first: the partial unique index allows one default
            }
            $row->is_default = true;
            $row->save();
            $this->audit->log('location.made_default', $row, [
                'name' => $row->name,
                'from' => $previous === null ? null : ['id' => $previous->id, 'name' => $previous->name],
            ]);

            return $row;
        });
    }

    /**
     * P88C-17 reasons the location can't be archived.
     *
     * @return list<string>
     */
    public function archiveBlockers(Store $store, Location $location): array
    {
        $reasons = [];
        if ($location->is_default) {
            $reasons[] = 'is_default';
        }
        $stock = Inventory::query()->where('store_id', $store->id)->where('location_id', $location->id)
            ->selectRaw('coalesce(sum(CASE WHEN on_hand <> 0 THEN 1 ELSE 0 END), 0) as stocked, coalesce(sum(CASE WHEN committed <> 0 THEN 1 ELSE 0 END), 0) as held')
            ->toBase()->first();
        if ((int) ($stock->stocked ?? 0) > 0) {
            $reasons[] = 'has_stock';
        }
        if ((int) ($stock->held ?? 0) > 0) {
            $reasons[] = 'has_committed';
        }
        if (PurchaseOrder::query()->where('store_id', $store->id)->where('location_id', $location->id)->whereIn('status', self::PO_STATUSES)->exists()) {
            $reasons[] = 'open_purchase_orders';
        }
        // Part B: a draft or in-transit transfer from or to it, or a count in progress there.
        if (StockTransfer::query()->where('store_id', $store->id)->whereIn('status', StockTransfer::OPEN)
            ->where(fn ($q) => $q->where('from_location_id', $location->id)->orWhere('to_location_id', $location->id))->exists()) {
            $reasons[] = 'open_transfers';
        }
        if (StockCount::query()->where('store_id', $store->id)->where('location_id', $location->id)->where('status', StockCount::IN_PROGRESS)->exists()) {
            $reasons[] = 'open_counts';
        }

        return $reasons;
    }

    /** @param list<string> $reasons */
    private static function blockedMessage(array $reasons): string
    {
        $parts = [
            'is_default' => 'online orders ship from it (make another location the default first)',
            'has_stock' => 'it still has stock',
            'has_committed' => 'orders are holding stock there',
            'open_purchase_orders' => 'open purchase orders receive there',
            'open_transfers' => 'a transfer from or to it is not finished',
            'open_counts' => 'a stock count is in progress there',
        ];

        return 'This location can’t be archived: '.implode('; ', array_map(fn ($r) => $parts[$r] ?? $r, $reasons)).'.';
    }

    /**
     * Every location row of the store, locked FOR UPDATE (id order).
     *
     * @return list<Location>
     */
    private function lockAll(Store $store): array
    {
        // The store row is the mutex (FOR NO KEY UPDATE: FK checks of other tables' inserts aren't blocked). Locking
        // only the location rows would let a parallel create miss a row inserted while it waited (READ COMMITTED).
        if (DB::getDriverName() === 'pgsql') {
            DB::select('SELECT id FROM stores WHERE id = ? FOR NO KEY UPDATE', [$store->id]);
        }

        return Location::query()->where('store_id', $store->id)->orderBy('id')->lockForUpdate()->get()->all();
    }

    /** @param list<Location> $rows the store's locked locations */
    private function assertCanAddActive(array $rows): void
    {
        $active = count(array_filter($rows, fn (Location $l) => ! $l->isArchived()));
        if ($active >= 1) {
            $tenant = $this->context->tenant();
            if ($tenant !== null) {
                FeatureGate::assertAllows($tenant, Feature::MultiWarehouse);
            }
        }
        if ($active >= Location::MAX_ACTIVE) {
            $max = Location::MAX_ACTIVE;
            throw new ApiException(422, 'limit_reached', "A store can have at most {$max} active locations. Archive one first.", ['name' => ["A store can have at most {$max} active locations."]]);
        }
    }

    /** @param array<string, mixed> $input */
    private function fill(Store $store, Location $location, array $input): void
    {
        if (array_key_exists('name', $input)) {
            $location->name = trim((string) $input['name']);
        }
        if (array_key_exists('type', $input)) {
            $location->type = (string) $input['type'];
        }
        $pickup = null;
        if (array_key_exists('pickup_location_id', $input)) {
            if ($input['pickup_location_id'] === null || $input['pickup_location_id'] === '') {
                $location->pickup_location_id = null;
            } else {
                $pickup = PickupLocation::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['pickup_location_id']))->first();
                if ($pickup === null) {
                    throw ValidationException::withMessages(['pickup_location_id' => ['Unknown pickup address.']]);
                }
                $location->pickup_location_id = $pickup->id;
            }
        }
        if (array_key_exists('address', $input)) {
            $address = is_string($input['address']) ? trim($input['address']) : null;
            $location->address = $address === '' ? null : $address;
        }
        // "Use a pickup address": the address is prefilled from it unless one was typed.
        if ($pickup !== null && ! array_key_exists('address', $input)) {
            $location->address = mb_substr($pickup->address_line, 0, 200);
        }
    }

    private function assertNameFree(Store $store, Location $location): void
    {
        if ($location->isArchived()) {
            return;
        }
        $taken = Location::query()->where('store_id', $store->id)->whereNull('archived_at')
            ->whereRaw('lower(name) = ?', [mb_strtolower($location->name)])
            ->when($location->exists, fn ($q) => $q->whereKeyNot($location->id))->exists();
        if ($taken) {
            throw self::nameTaken();
        }
    }

    private static function nameTaken(): ApiException
    {
        return new ApiException(422, 'location_name_taken', self::DUPLICATE_NAME, ['name' => [self::DUPLICATE_NAME]]);
    }

    /**
     * @template T
     *
     * @param  callable(): T  $fn
     * @return T
     */
    private function unique(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (UniqueConstraintViolationException) {
            throw self::nameTaken();
        }
    }
}
