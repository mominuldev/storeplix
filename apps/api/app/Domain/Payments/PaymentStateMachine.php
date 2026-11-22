<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Orders\Models\Payment;
use Illuminate\Support\Facades\DB;

/**
 * Payment row statuses (P5B-20). Every change is a conditional UPDATE … WHERE id = ? AND status = ? run by the caller
 * inside a transaction that already holds the order row lock (lock order: order → payments → inventories → coupon →
 * counter). Zero affected rows = somebody else handled it first: the caller returns the current state, no effects.
 *
 * pending → succeeded | failed | cancelled. A charge that is no longer pending but the provider later reports as paid
 * (late payment, P5B-21) goes failed|cancelled → succeeded exactly once and is then refunded automatically.
 */
final class PaymentStateMachine
{
    public const PENDING = 'pending';

    public const SUCCEEDED = 'succeeded';

    public const FAILED = 'failed';

    public const CANCELLED = 'cancelled';

    /** @var array<string, list<string>> */
    public const TRANSITIONS = [
        self::PENDING => [self::SUCCEEDED, self::FAILED, self::CANCELLED],
        self::FAILED => [self::SUCCEEDED],      // late payment only (then refunded)
        self::CANCELLED => [self::SUCCEEDED],   // late payment only (then refunded)
        self::SUCCEEDED => [],
    ];

    public static function can(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    /**
     * Conditional transition. Returns true when THIS call changed the row (exactly one row affected).
     *
     * @param  array<string, mixed>  $columns  extra columns written with the status
     */
    public static function move(Payment $payment, string $from, string $to, array $columns = []): bool
    {
        if (! self::can($from, $to)) {
            return false;
        }
        $now = now();
        $affected = DB::table('payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->where('status', $from)
            ->update(['status' => $to, 'updated_at' => $now] + $columns);
        if ($affected !== 1) {
            return false;
        }
        // Raw DB values (json strings, Carbon) mirror what was written; the casts read them as usual.
        $payment->setRawAttributes(array_merge($payment->getAttributes(), ['status' => $to, 'updated_at' => $now] + $columns), true);

        return true;
    }
}
