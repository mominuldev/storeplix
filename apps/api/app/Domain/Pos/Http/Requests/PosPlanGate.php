<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Tenancy\TenantContext;

/** PHASE-8-8D §2.2 (P88D-19): plan `pos` on every POS write except close / register edit / archive → 402 `feature_not_in_plan`. */
final class PosPlanGate
{
    public static function assert(): void
    {
        $tenant = app(TenantContext::class)->tenant();
        if ($tenant !== null) {
            FeatureGate::assertAllows($tenant, Feature::Pos);
        }
    }
}
