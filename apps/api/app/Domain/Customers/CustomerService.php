<?php

namespace App\Domain\Customers;

use App\Domain\Customers\Models\Customer;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/** Customer rules (P4-16, P4-17, §3.5). */
class CustomerService
{
    public const FIELDS = ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags', 'accepts_marketing'];

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $input normalised CreateCustomerInput */
    public function create(Store $store, array $input, ?User $user, string $source = Customer::SOURCE_MANUAL): Customer
    {
        return $this->guard(fn () => DB::transaction(function () use ($store, $input, $user, $source) {
            $this->assertUnique($store, $input['phone'] ?? null, $input['email'] ?? null, null);
            $customer = new Customer(array_intersect_key($input, array_flip(self::FIELDS)));
            $customer->store_id = $store->id;
            $customer->source = $source;
            $customer->created_by = $user?->getKey();
            $customer->save();

            return $customer;
        }));
    }

    /** @param array<string, mixed> $input normalised UpdateCustomerInput */
    public function update(Store $store, Customer $customer, array $input, ?int $revision, ?User $user): Customer
    {
        return $this->guard(fn () => DB::transaction(function () use ($store, $customer, $input, $revision) {
            /** @var Customer $locked */
            $locked = Customer::query()->whereKey($customer->id)->lockForUpdate()->firstOrFail();
            if ($revision !== null && $locked->revision !== $revision) {
                throw StoreThemeService::conflict();
            }
            $locked->fill(array_intersect_key($input, array_flip(self::FIELDS)));
            if ($locked->phone === null && $locked->email === null) {
                throw ValidationException::withMessages(['phone' => ['Enter a phone number or an email.']]);
            }
            $this->assertUnique($store, $locked->isDirty('phone') ? $locked->phone : null, $locked->isDirty('email') ? $locked->email : null, $locked->id);
            if ($locked->isDirty()) {
                $locked->revision++;
                $locked->save();
            }

            return $locked;
        }));
    }

    public function delete(Customer $customer): void
    {
        DB::transaction(function () use ($customer) {
            $customer->delete();
            $this->audit->log('customer.deleted', $customer);
        });
    }

    public function addNote(Customer $customer, string $body, ?User $author): CustomerNote
    {
        $note = new CustomerNote(['body' => $body]);
        $note->store_id = $customer->store_id;
        $note->customer_id = $customer->id;
        $note->author_user_id = $author?->getKey();
        $note->save();

        return $note;
    }

    private function assertUnique(Store $store, ?string $phone, ?string $email, ?string $exceptId): void
    {
        $errors = [];
        if ($phone !== null && Customer::query()->where('store_id', $store->id)->where('phone', $phone)
            ->when($exceptId, fn ($q) => $q->whereKeyNot($exceptId))->exists()) {
            $errors['phone'] = ['A customer with this phone already exists.'];
        }
        if ($email !== null && Customer::query()->where('store_id', $store->id)->where('email', $email)
            ->when($exceptId, fn ($q) => $q->whereKeyNot($exceptId))->exists()) {
            $errors['email'] = ['A customer with this email already exists.'];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
    }

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    private function guard(callable $callback): mixed
    {
        try {
            return $callback();
        } catch (QueryException $e) {
            if (str_contains($e->getMessage(), 'customers_store_phone_unique') || str_contains($e->getMessage(), 'customers.phone')) {
                throw ValidationException::withMessages(['phone' => ['A customer with this phone already exists.']]);
            }
            if (str_contains($e->getMessage(), 'customers_store_email_unique') || str_contains($e->getMessage(), 'customers.email')) {
                throw ValidationException::withMessages(['email' => ['A customer with this email already exists.']]);
            }
            throw $e;
        }
    }
}
