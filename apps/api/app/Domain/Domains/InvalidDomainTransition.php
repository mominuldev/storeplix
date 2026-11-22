<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Shared\Http\ApiException;

/** P6-10: a transition outside DomainStateMachine::TRANSITIONS (409 `invalid_state_transition`). */
final class InvalidDomainTransition extends ApiException
{
    public function __construct(public readonly string $from, public readonly string $to)
    {
        parent::__construct(409, 'invalid_state_transition', $from === 'suspended'
            ? 'This domain was suspended by Store Plix. Contact support.'
            : "A domain can't move from {$from} to {$to}.");
    }
}
