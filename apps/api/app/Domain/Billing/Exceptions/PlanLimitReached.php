<?php

namespace App\Domain\Billing\Exceptions;

use App\Domain\Billing\Limit;
use App\Domain\Shared\Http\ApiException;

/** 402 plan_limit_reached; `details.upgrade_plan` = the cheapest plan that would allow it (P7-17), omitted when none. */
class PlanLimitReached extends ApiException
{
    public function __construct(public readonly Limit $limit, int $max, ?string $upgradePlan = null)
    {
        $label = str_replace('_', ' ', $limit->value);
        $details = [$limit->value => ["Your plan allows {$max} {$label}."]];
        if ($upgradePlan !== null) {
            $details['upgrade_plan'] = [$upgradePlan];
        }

        parent::__construct(402, 'plan_limit_reached', "Your plan allows {$max} {$label}.", $details);
    }
}
