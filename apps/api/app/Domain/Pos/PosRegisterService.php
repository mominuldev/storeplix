<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Register writes (PHASE-8-8D §4, P88D-4, P88D-23). Validated input is mapped field by field (tenant_id, store_id,
 * archived_at and created_by never come from the body). Every write locks the store row first, so the 10-register cap
 * and the active-name rule can't be raced (the partial unique index is the final guard). Every write is audited.
 * The plan (`pos`) is checked by the Form Request on create / unarchive (402 before validation).
 */
final class PosRegisterService
{
    public const NAME_TAKEN = 'You already have a register with this name.';

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array{name: string, location_id: string, position?: int} $input */
    public function create(Store $store, array $input, ?User $user): PosRegister
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $input, $user) {
            $this->lockStore($store);
            $this->assertCanAddActive($store);
            $location = Locations::resolve($store->id, $input['location_id']); // foreign → 422, archived → location_archived

            $register = new PosRegister;
            $register->store_id = $store->id;
            $register->location_id = $location->id;
            $register->name = trim($input['name']);
            $register->position = $input['position'] ?? ((int) PosRegister::query()->where('store_id', $store->id)->max('position') + 1);
            $register->created_by = $user?->id;
            $this->assertNameFree($store, $register);
            $register->save();
            $this->audit->log('pos_register.created', $register, ['name' => $register->name, 'location_id' => $location->id]);

            return $register;
        }));
    }

    /** @param array{name?: string, location_id?: string, position?: int} $input */
    public function update(Store $store, PosRegister $register, array $input): PosRegister
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $register, $input) {
            $this->lockStore($store);
            /** @var PosRegister $row */
            $row = PosRegister::query()->where('store_id', $store->id)->whereKey($register->id)->lockForUpdate()->firstOrFail();
            if (array_key_exists('name', $input)) {
                $row->name = trim($input['name']);
            }
            if (array_key_exists('position', $input)) {
                $row->position = (int) $input['position'];
            }
            if (array_key_exists('location_id', $input) && strtolower($input['location_id']) !== $row->location_id) {
                $location = Locations::resolve($store->id, $input['location_id']);
                if ($this->openSession($row) !== null) {
                    throw new ApiException(409, 'register_in_use', 'Close this register before moving it to another location.');
                }
                $row->location_id = $location->id;
            }
            if (! $row->isDirty()) {
                return $row;
            }
            $changed = array_values(array_diff(array_keys($row->getDirty()), ['updated_at']));
            if ($row->isDirty('name') && $row->archived_at === null) {
                $this->assertNameFree($store, $row);
            }
            $row->save();
            $this->audit->log('pos_register.updated', $row, ['changed' => $changed]);

            return $row;
        }));
    }

    public function archive(Store $store, PosRegister $register): PosRegister
    {
        return DB::transaction(function () use ($store, $register) {
            $this->lockStore($store);
            /** @var PosRegister $row */
            $row = PosRegister::query()->where('store_id', $store->id)->whereKey($register->id)->lockForUpdate()->firstOrFail();
            if ($row->isArchived()) {
                throw new ApiException(409, 'invalid_state_transition', 'This register is already archived.');
            }
            if ($this->openSession($row) !== null) {
                throw new ApiException(409, 'register_in_use', 'Close this register before archiving it.');
            }
            $row->archived_at = now();
            $row->save();
            $this->audit->log('pos_register.archived', $row, ['name' => $row->name]);

            return $row;
        });
    }

    public function unarchive(Store $store, PosRegister $register): PosRegister
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $register) {
            $this->lockStore($store);
            /** @var PosRegister $row */
            $row = PosRegister::query()->where('store_id', $store->id)->whereKey($register->id)->lockForUpdate()->firstOrFail();
            if (! $row->isArchived()) {
                throw new ApiException(409, 'invalid_state_transition', 'This register is not archived.');
            }
            $this->assertCanAddActive($store);
            Locations::resolve($store->id, $row->location_id); // its location must be active again first
            $row->archived_at = null;
            $this->assertNameFree($store, $row);
            $row->save();
            $this->audit->log('pos_register.unarchived', $row, ['name' => $row->name]);

            return $row;
        }));
    }

    private function openSession(PosRegister $register): ?PosSession
    {
        return PosSession::query()->where('register_id', $register->id)->where('status', PosSession::OPEN)->first();
    }

    private function lockStore(Store $store): void
    {
        Store::query()->whereKey($store->id)->lockForUpdate()->first();
    }

    private function assertCanAddActive(Store $store): void
    {
        $max = (int) config('pos.max_registers', 10);
        if (PosRegister::query()->where('store_id', $store->id)->whereNull('archived_at')->count() >= $max) {
            throw new ApiException(409, 'register_limit_reached', "You can have up to {$max} active registers. Archive one first.");
        }
    }

    private function assertNameFree(Store $store, PosRegister $register): void
    {
        $taken = PosRegister::query()->where('store_id', $store->id)->whereNull('archived_at')
            ->whereRaw('lower(name) = ?', [mb_strtolower($register->name)])
            ->when($register->exists, fn ($q) => $q->whereKeyNot($register->id))->exists();
        if ($taken) {
            throw self::nameTaken();
        }
    }

    private static function nameTaken(): ApiException
    {
        return new ApiException(422, 'register_name_taken', self::NAME_TAKEN, ['name' => [self::NAME_TAKEN]]);
    }

    /** The partial unique index is the final guard against a parallel write with the same name. @template T @param callable(): T $write @return T */
    private function unique(callable $write): mixed
    {
        try {
            return $write();
        } catch (UniqueConstraintViolationException) {
            throw self::nameTaken();
        }
    }
}
