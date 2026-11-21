<?php

namespace App\Domain\Billing\Exceptions;

use App\Domain\Billing\Feature;
use App\Domain\Shared\Http\ApiException;

class FeatureNotInPlan extends ApiException
{
    public function __construct(Feature $feature)
    {
        parent::__construct(402, 'feature_not_in_plan', 'Your plan does not include this feature.', [
            'feature' => [$feature->value],
        ]);
    }
}
