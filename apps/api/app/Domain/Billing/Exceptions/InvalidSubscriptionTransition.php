<?php

declare(strict_types=1);

namespace App\Domain\Billing\Exceptions;

use LogicException;

final class InvalidSubscriptionTransition extends LogicException
{
    public function __construct(public readonly string $from, public readonly string $to)
    {
        parent::__construct("Subscription cannot move from {$from} to {$to}.");
    }
}
