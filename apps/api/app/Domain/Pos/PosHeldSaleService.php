<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Held sales (PHASE-8-8D §9, P88D-16, S207): park a cart on the register of an open session, ≤ 20 per register (the
 * register row is locked, so the cap can't be raced). Nothing is reserved; the total is the server's at hold time.
 * Resuming = the client reloads the lines and re-quotes; the sale naming `held_sale_id` deletes it (PosSaleService).
 */
final class PosHeldSaleService
{
    public function __construct(
        private readonly PosPricing $pricing,
        private readonly AuditLogger $audit,
    ) {}

    /** @param array<string, mixed> $input validated PosHeldSaleInput (customer.phone normalised) */
    public function hold(Store $store, array $input, User $user): PosHeldSale
    {
        $session = PosSaleService::openSession($store, (string) $input['session_id']);
        $lines = array_map(fn (array $l) => ['variant_id' => strtolower((string) $l['variant_id']), 'quantity' => (int) $l['quantity']], array_values($input['lines']));
        [$customerId, $name, $phone] = $this->customer($store, $input);
        $quote = $this->pricing->quote($store->id, $session->location_id, $session->currency, $lines, $input['coupon_code'] ?? null, $phone);

        return DB::transaction(function () use ($store, $session, $lines, $customerId, $name, $phone, $quote, $input, $user) {
            PosRegister::query()->where('store_id', $store->id)->whereKey($session->register_id)->lockForUpdate()->firstOrFail();
            $max = PosHeldSale::MAX_PER_REGISTER;
            if (PosHeldSale::query()->where('register_id', $session->register_id)->count() >= $max) {
                throw new ApiException(409, 'held_sales_limit', "This register already has {$max} held sales. Resume or delete one first.");
            }
            $note = isset($input['note']) && trim((string) $input['note']) !== '' ? trim((string) $input['note']) : null;

            $held = new PosHeldSale;
            $held->store_id = $store->id;
            $held->register_id = $session->register_id;
            $held->session_id = $session->id;
            $held->customer_id = $customerId;
            $held->customer_name = $name;
            $held->customer_phone = $phone;
            $held->coupon_code = $quote['coupon_code'];
            $held->note = $note;
            $held->lines = $lines;
            $held->items_count = array_sum(array_column($lines, 'quantity'));
            $held->total_amount = (int) $quote['total_amount'];
            $held->currency = $session->currency;
            $held->held_by = $user->id;
            $held->created_at = now();
            $held->save();

            return $held;
        });
    }

    public function delete(Store $store, PosHeldSale $held): void
    {
        DB::transaction(function () use ($store, $held) {
            $deleted = PosHeldSale::query()->where('store_id', $store->id)->whereKey($held->id)->delete();
            if ($deleted === 1) {
                $this->audit->log('pos_held_sale.deleted', $held, ['register_id' => $held->register_id, 'items_count' => $held->items_count, 'total_amount' => $held->total_amount]);
            }
        });
    }

    /**
     * Who the parked sale is for: `customer_id` (this store's), else `customer {phone, name?}` (an existing customer by
     * phone gives the id and name), else walk-in. Unlike a sale, a new phone needs no name yet.
     *
     * @param  array<string, mixed>  $input
     * @return array{0: string|null, 1: string|null, 2: string|null} id, name, phone (8801…)
     */
    private function customer(Store $store, array $input): array
    {
        if (($input['customer_id'] ?? null) !== null) {
            $c = Customer::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['customer_id']))->first()
                ?? throw ValidationException::withMessages(['customer_id' => ['Unknown customer.']]);

            return [$c->id, (string) $c->name, $c->phone !== null && $c->phone !== '' ? (string) $c->phone : null];
        }
        if (($input['customer'] ?? null) !== null) {
            $phone = (string) $input['customer']['phone'];
            $c = Customer::query()->where('store_id', $store->id)->where('phone', $phone)->first();
            $name = trim((string) ($input['customer']['name'] ?? ''));

            return [$c?->id, $c !== null ? (string) $c->name : ($name !== '' ? mb_substr($name, 0, 120) : null), $phone];
        }

        return [null, null, null];
    }
}
