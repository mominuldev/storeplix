<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Identity\Models\User;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Supplier writes (PHASE-8-8B §4). Validated input is mapped field by field (tenant_id, store_id, created_by never come
 * from the body). One active supplier per name (case-insensitive); archived suppliers free the name. Delete only when
 * the supplier has no POs and no payments (else 409 `supplier_in_use`, archive instead). Every write audited (P88B-18).
 */
final class SupplierService
{
    public const DUPLICATE_NAME = 'You already have a supplier with this name.';

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $input */
    public function create(Store $store, array $input, ?User $user, bool $audit = true): Supplier
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $input, $user, $audit) {
            $supplier = new Supplier;
            $supplier->store_id = $store->id;
            $this->fill($supplier, $input);
            $supplier->created_by = $user?->id;
            $this->assertNameFree($store, $supplier);
            $supplier->save();
            if ($audit) {
                $this->audit->log('purchasing.supplier_created', $supplier, ['name' => $supplier->name]);
            }

            return $supplier;
        }));
    }

    /** @param array<string, mixed> $input partial */
    public function update(Store $store, Supplier $supplier, array $input, ?User $user = null, bool $audit = true): Supplier
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $supplier, $input, $audit) {
            /** @var Supplier $row */
            $row = Supplier::query()->where('store_id', $store->id)->whereKey($supplier->id)->lockForUpdate()->firstOrFail();
            $this->fill($row, $input);
            if (! $row->isDirty()) {
                return $row;
            }
            $changed = array_keys($row->getDirty());
            if ($row->isDirty('name')) {
                $this->assertNameFree($store, $row);
            }
            $row->save();
            if ($audit) {
                $this->audit->log('purchasing.supplier_updated', $row, ['name' => $row->name, 'changed' => array_values(array_diff($changed, ['updated_at']))]);
            }

            return $row;
        }));
    }

    public function archive(Store $store, Supplier $supplier, bool $archived): Supplier
    {
        return $this->unique(fn () => DB::transaction(function () use ($store, $supplier, $archived) {
            /** @var Supplier $row */
            $row = Supplier::query()->where('store_id', $store->id)->whereKey($supplier->id)->lockForUpdate()->firstOrFail();
            if ($row->isArchived() === $archived) {
                return $row;
            }
            if (! $archived) {
                $this->assertNameFree($store, $row);
            }
            $row->archived_at = $archived ? now() : null;
            $row->save();
            $this->audit->log($archived ? 'purchasing.supplier_archived' : 'purchasing.supplier_unarchived', $row, ['name' => $row->name]);

            return $row;
        }));
    }

    public function delete(Store $store, Supplier $supplier): void
    {
        DB::transaction(function () use ($store, $supplier) {
            /** @var Supplier $row */
            $row = Supplier::query()->where('store_id', $store->id)->whereKey($supplier->id)->lockForUpdate()->firstOrFail();
            if (PurchaseOrder::query()->where('supplier_id', $row->id)->exists() || SupplierPayment::query()->where('supplier_id', $row->id)->exists()) {
                throw new ApiException(409, 'supplier_in_use', 'This supplier has purchase orders or payments. Archive it instead.');
            }
            $snapshot = ['name' => $row->name, 'phone' => $row->phone !== null ? Phone::mask($row->phone) : null, 'city' => $row->city];
            $row->delete();
            $this->audit->log('purchasing.supplier_deleted', $row, $snapshot);
        });
    }

    /** @param array<string, mixed> $input */
    private function fill(Supplier $supplier, array $input): void
    {
        foreach (Supplier::FIELDS as $field) {
            if (! array_key_exists($field, $input)) {
                continue;
            }
            $value = $input[$field];
            if (is_string($value)) {
                $value = trim($value);
                $value = $value === '' && $field !== 'name' ? null : $value;
            }
            if ($field === 'phone' && $value !== null) {
                $value = Phone::bdMsisdn((string) $value);
            }
            $supplier->{$field} = $value;
        }
    }

    private function assertNameFree(Store $store, Supplier $supplier): void
    {
        if ($supplier->isArchived()) {
            return;
        }
        $taken = Supplier::query()->where('store_id', $store->id)->whereNull('archived_at')
            ->whereRaw('lower(name) = ?', [mb_strtolower($supplier->name)])
            ->when($supplier->exists, fn ($q) => $q->whereKeyNot($supplier->id))->exists();
        if ($taken) {
            throw ValidationException::withMessages(['name' => [self::DUPLICATE_NAME]]);
        }
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
            throw ValidationException::withMessages(['name' => [self::DUPLICATE_NAME]]);
        }
    }
}
