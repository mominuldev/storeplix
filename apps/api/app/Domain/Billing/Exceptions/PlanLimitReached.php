<?php

namespace App\Domain\Billing\Exceptions;

use App\Domain\Billing\Limit;
use App\Domain\Shared\Http\ApiException;

class PlanLimitReached extends ApiException
{
    public function __construct(Limit $limit, int $max)
    {
        $label = str_replace('_', ' ', $limit->value);

        parent::__construct(402, 'plan_limit_reached', "Your plan allows {$max} {$label}.", [
            $limit->value => ["Your plan allows {$max} {$label}."],
        ]);
    }
}
