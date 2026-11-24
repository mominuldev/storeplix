<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Phone;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;

/**
 * A phone's OWN-SHOP delivery record (PHASE-8-8 §3.1, P88-1, P88-8): this store's orders with that phone only — never
 * another store, another tenant or a courier (no HTTP call, S161). Computed by phone, not by customer row (a phone may
 * have no customer yet).
 *
 *   delivered = orders with status `delivered`
 *   returned  = other orders with status `returned` or a `returned` shipment
 *
 * Cancelled-before-shipping orders don't count. Call inside the tenant context (tenant-scoped queries).
 */
final class ShopRecord
{
    public function __construct(
        public readonly int $delivered,
        public readonly int $returned,
        public readonly ?Carbon $lastReturnAt,
    ) {}

    public static function for(string $storeId, string $phone, ?string $excludeOrderId = null): self
    {
        $msisdn = Phone::bdMsisdn($phone) ?? $phone;
        $base = fn (): Builder => Order::query()->where('orders.store_id', $storeId)->where('orders.customer_phone', $msisdn)
            ->when($excludeOrderId !== null, fn (Builder $q) => $q->whereKeyNot($excludeOrderId));

        $delivered = $base()->where('orders.status', Order::DELIVERED)->count();
        $returnedShipment = fn ($q) => $q->selectRaw('1')->from('shipments')->whereColumn('shipments.order_id', 'orders.id')->where('shipments.status', 'returned');
        $returned = $base()->where('orders.status', '<>', Order::DELIVERED)
            ->where(fn (Builder $w) => $w->where('orders.status', Order::RETURNED)->orWhereExists($returnedShipment));
        $count = (clone $returned)->count();
        $last = $count > 0 ? (clone $returned)->max('orders.returned_at') : null;
        if ($count > 0 && $last === null) {
            $last = $base()->join('shipments', 'shipments.order_id', '=', 'orders.id')->where('shipments.status', 'returned')->max('shipments.returned_at');
        }

        return new self($delivered, $count, $last !== null ? Carbon::parse($last) : null);
    }

    public function total(): int
    {
        return $this->delivered + $this->returned;
    }

    public function rate(): ?int
    {
        return RiskTier::rate($this->delivered, $this->total());
    }

    /** @return list<array{key: string, delivered: int, total: int}> GuardRecordSource[] (P88-7: the shop only) */
    public function sources(): array
    {
        return [['key' => 'shop', 'delivered' => $this->delivered, 'total' => $this->total()]];
    }
}
