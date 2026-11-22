<?php

namespace App\Domain\Returns;

use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shared\Http\ApiException;

/**
 * P5B-64: requested → approved | rejected; approved → received | closed; received → refunded | exchanged | closed.
 * refunded, exchanged, rejected and closed are final. (`pickup_booked` needs courier return APIs: deferred.)
 */
final class ReturnStateMachine
{
    /** @var array<string, list<string>> */
    public const TRANSITIONS = [
        ReturnRequest::REQUESTED => [ReturnRequest::APPROVED, ReturnRequest::REJECTED],
        ReturnRequest::APPROVED => [ReturnRequest::RECEIVED, ReturnRequest::CLOSED],
        ReturnRequest::RECEIVED => [ReturnRequest::REFUNDED, ReturnRequest::EXCHANGED, ReturnRequest::CLOSED],
        ReturnRequest::REFUNDED => [],
        ReturnRequest::EXCHANGED => [],
        ReturnRequest::REJECTED => [],
        ReturnRequest::CLOSED => [],
    ];

    public static function can(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function assert(string $from, string $to): void
    {
        if (! self::can($from, $to)) {
            throw new ApiException(409, 'invalid_state_transition', "This return is {$from}, so it can’t be marked {$to}.");
        }
    }

    /** @return list<string> allowed next statuses (exchanged only for exchanges; refunded comes from a refund) */
    public static function allowed(ReturnRequest $return): array
    {
        return array_values(array_filter(
            self::TRANSITIONS[$return->status] ?? [],
            fn (string $to) => $to !== ReturnRequest::EXCHANGED || ($return->type === 'exchange' && $return->exchange_order_id === null),
        ));
    }
}
