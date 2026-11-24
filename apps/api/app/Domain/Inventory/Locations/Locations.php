<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Locations;

use App\Domain\Inventory\Models\Location;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shipping\Models\PickupLocation;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Location lookups (PHASE-8-8C §4–§5). The default location IS the online location (P88C-4). Every store always has
 * one: StoreProvisioner and the 8.8c backfill create it; ensureDefault() also creates it lazily for a store that has
 * none (e.g. a store row created outside the provisioner), so stock writes never fail for want of a location.
 * Call inside the store's tenant context.
 */
final class Locations
{
    /** The store's default (= online) location id; created when missing. */
    public static function defaultId(string $storeId): string
    {
        $id = Location::query()->where('store_id', $storeId)->where('is_default', true)->value('id');

        return is_string($id) ? $id : self::ensureDefault($storeId)->id;
    }

    /**
     * Creates the "Main warehouse" default of a store that has none (address prefilled from the default pickup
     * address). Race-safe: the partial unique index allows one default; the loser re-reads the winner's row.
     */
    public static function ensureDefault(string $storeId, ?string $actorId = null): Location
    {
        $existing = Location::query()->where('store_id', $storeId)->where('is_default', true)->first();
        if ($existing !== null) {
            return $existing;
        }
        try {
            return DB::transaction(function () use ($storeId, $actorId) { // savepoint: a lost race doesn't abort the caller
                $pickup = PickupLocation::query()->where('store_id', $storeId)->where('is_default', true)->first();
                $location = new Location;
                $location->store_id = $storeId;
                $location->name = Location::DEFAULT_NAME;
                $location->type = 'warehouse';
                $location->address = $pickup !== null ? mb_substr($pickup->address_line, 0, 200) : null;
                $location->pickup_location_id = $pickup?->id;
                $location->is_default = true;
                $location->position = 0;
                $location->created_by = $actorId;
                $location->save();

                return $location;
            });
        } catch (UniqueConstraintViolationException) {
            return Location::query()->where('store_id', $storeId)->where('is_default', true)->firstOrFail();
        }
    }

    /** Non-archived locations of the store, default first, then position, then name. @return list<Location> */
    public static function active(string $storeId): array
    {
        return Location::query()->where('store_id', $storeId)->whereNull('archived_at')
            ->orderByDesc('is_default')->orderBy('position')->orderBy('name')->orderBy('id')->get()->all();
    }

    public static function activeCount(string $storeId): int
    {
        return Location::query()->where('store_id', $storeId)->whereNull('archived_at')->count();
    }

    /**
     * Resolves an optional `location_id` input of the store: null → the default location; another store's or
     * tenant's id → 422 validation_failed on $field (S179); archived → 422 `location_archived` (unless allowed).
     */
    public static function resolve(string $storeId, ?string $locationId, string $field = 'location_id', bool $allowArchived = false): Location
    {
        if ($locationId === null || $locationId === '') {
            $id = self::defaultId($storeId);

            return Location::query()->whereKey($id)->firstOrFail();
        }
        $location = Location::query()->where('store_id', $storeId)->whereKey(strtolower($locationId))->first();
        if ($location === null) {
            throw ValidationException::withMessages([$field => ['Unknown location.']]);
        }
        if (! $allowArchived && $location->isArchived()) {
            throw new ApiException(422, 'location_archived', 'This location is archived. Unarchive it first.', [$field => ["{$location->name} is archived."]]);
        }

        return $location;
    }

    /** Names of every location of the store (archived included) by id, for ledger/presenter refs. @return array<string, string> */
    public static function names(string $storeId): array
    {
        /** @var array<string, string> */
        return Location::query()->where('store_id', $storeId)->pluck('name', 'id')->all();
    }
}
