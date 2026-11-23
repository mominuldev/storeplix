<?php

namespace App\Domain\Billing\Exceptions;

use App\Domain\Billing\Feature;
use App\Domain\Shared\Http\ApiException;

/** 402 feature_not_in_plan; `details.upgrade_plan` = the cheapest plan including the feature (P7-17), omitted when none. */
class FeatureNotInPlan extends ApiException
{
    public function __construct(public readonly Feature $feature, ?string $upgradePlan = null)
    {
        $details = ['feature' => [$feature->value]];
        if ($upgradePlan !== null) {
            $details['upgrade_plan'] = [$upgradePlan];
        }

        parent::__construct(402, 'feature_not_in_plan', 'Your plan does not include this feature.', $details);
    }
}
