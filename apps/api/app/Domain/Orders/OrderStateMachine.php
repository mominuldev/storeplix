<?php

namespace App\Domain\Orders;

use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;

/**
 * P5-17 / ADR 0011. The only allowed status changes; everything else is 409 invalid_state_transition.
 * 5b-2 (P5B-14, amends P5-17): `pending_payment` → confirmed (verified payment, actor system), → pending (shopper
 * switches to COD), → cancelled (hold expired, or a merchant cancel). Merchants may only cancel it.
 */
final class OrderStateMachine
{
    /** @var array<string, list<string>> mirrors ORDER_TRANSITIONS in @storeplix/types */
    public const TRANSITIONS = [
        Order::PENDING_PAYMENT => [Order::CONFIRMED, Order::PENDING, Order::CANCELLED],
        Order::PENDING => [Order::CONFIRMED, Order::CANCELLED],
        Order::CONFIRMED => [Order::READY_TO_SHIP, Order::SHIPPED, Order::CANCELLED],
        Order::READY_TO_SHIP => [Order::SHIPPED, Order::CONFIRMED, Order::CANCELLED],
        Order::SHIPPED => [Order::DELIVERED, Order::RETURNED],
        Order::DELIVERED => [],
        Order::RETURNED => [],
        Order::CANCELLED => [],
    ];

    public static function can(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function assert(string $from, string $to): void
    {
        if (! self::can($from, $to)) {
            throw new ApiException(409, 'invalid_state_transition', self::message($from, $to));
        }
    }

    /**
     * Allowed next statuses for the current role (staff can't cancel a paid or part-paid order, P5-21). An unpaid
     * online order only confirms itself (payment) or moves to COD (shopper): merchants see `cancelled` only.
     */
    public static function allowedFor(Order $order, ?PermissionSet $permissions): array
    {
        $next = $order->status === Order::PENDING_PAYMENT ? [Order::CANCELLED] : (self::TRANSITIONS[$order->status] ?? []);
        if ($order->guard_hold !== null) {
            $next = array_values(array_diff($next, [Order::CONFIRMED])); // PHASE-8-8 P88-2: release first
        }

        return array_values(array_filter(
            $next,
            fn (string $to) => $to !== Order::CANCELLED || $order->paid_amount === 0 || ($permissions?->has(Permission::OrdersRefund) ?? false),
        ));
    }

    private static function message(string $from, string $to): string
    {
        $label = fn (string $s) => str_replace('_', ' ', $s === Order::SHIPPED ? 'in transit' : $s);

        return 'This order is '.$label($from).', so it can’t be marked '.$label($to).'.';
    }
}
