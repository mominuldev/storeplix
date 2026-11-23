<?php

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Http\Resources\PlanPresenter;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\Plan;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

class BillingController
{
    public function __construct(private readonly TenantContext $context) {}

    /** Public. */
    public function plans(): JsonResponse
    {
        $plans = Plan::query()->where('is_active', true)->orderBy('sort')->get();

        return new JsonResponse(['data' => $plans->map(fn (Plan $p) => PlanPresenter::plan($p))->all()]);
    }

    /** Owner + admin. */
    public function subscription(): JsonResponse
    {
        Gate::authorize('billing.view');

        $subscription = FeatureGate::currentSubscription()
            ?? throw new ApiException(404, 'not_found', 'No active subscription.');

        return new JsonResponse(['data' => PlanPresenter::subscription($subscription)]);
    }

    /** All roles: drives gating and "X of Y used" UI. */
    public function features(): JsonResponse
    {
        Gate::authorize('billing.features');

        $tenant = $this->context->tenant();
        $plan = FeatureGate::plan($tenant);

        $features = [];
        foreach (Feature::cases() as $feature) {
            $features[$feature->value] = FeatureGate::allows($tenant, $feature);
        }

        $limits = [];
        foreach (Limit::cases() as $limit) {
            $limits[$limit->value] = [
                'limit' => FeatureGate::limit($tenant, $limit),
                'used' => FeatureGate::usage($tenant, $limit),
            ];
        }

        return new JsonResponse(['data' => [
            'plan_code' => $plan['code'],
            'subscription_status' => $plan['status'],
            'trial_ends_at' => $plan['trial_ends_at'],
            'features' => $features,
            'limits' => $limits,
            'grace_ends_at' => $plan['grace_ends_at'] ?? null,
            'domain_grace_ends_at' => $plan['domain_grace_ends_at'] ?? null,
        ]]);
    }
}
