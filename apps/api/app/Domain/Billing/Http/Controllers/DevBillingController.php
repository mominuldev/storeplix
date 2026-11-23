<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Http\Resources\PlanPresenter;
use App\Domain\Billing\Jobs\ProcessSubscriptionJob;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

/**
 * §4.6 TESTING-ONLY clock for the current tenant's subscription (B25). Registered only outside production; 404 unless
 * BILLING_FAKE=true; owner only. Moves the dates so the named state is due, then runs ProcessSubscriptionJob inline.
 */
final class DevBillingController
{
    public const STATES = ['trial_ends_soon', 'trial_ended', 'renewal_due', 'period_ended', 'grace_ends_soon', 'grace_ended', 'domain_grace_ended'];

    public function __invoke(Request $request, TenantContext $context, PlanChangeService $plans): JsonResponse
    {
        if (! (bool) config('billing.fake') || app()->environment('production')) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        Gate::authorize('billing.manage');
        $state = (string) $request->validate(['state' => ['required', 'string', 'in:'.implode(',', self::STATES)]])['state'];
        $tenantId = $context->requireId();

        BillingLock::run($tenantId, fn () => DB::transaction(function () use ($state, $plans) {
            $sub = $plans->current(lock: true);
            $now = now();
            $set = match ($state) {
                'trial_ends_soon' => $sub->status === Subscription::TRIALING ? ['trial_ends_at' => $now->copy()->addDays(2)] : null,
                'trial_ended' => $sub->status === Subscription::TRIALING ? ['trial_ends_at' => $now->copy()->subMinute()] : null,
                'renewal_due' => $sub->status === Subscription::ACTIVE ? ['current_period_end' => $now->copy()->addDays(6)] : null,
                'period_ended' => $sub->status === Subscription::ACTIVE ? ['current_period_end' => $now->copy()->subMinute()] : null,
                'grace_ends_soon' => $sub->status === Subscription::PAST_DUE ? ['grace_ends_at' => $now->copy()->addDay()] : null,
                'grace_ended' => $sub->status === Subscription::PAST_DUE ? ['grace_ends_at' => $now->copy()->subMinute()] : null,
                'domain_grace_ended' => $sub->domain_grace_ends_at !== null ? ['domain_grace_ends_at' => $now->copy()->subMinute()] : null,
            };
            if ($set === null) {
                throw new ApiException(409, 'invalid_state', "The subscription is {$sub->status}: {$state} does not apply.");
            }
            if ($state === 'renewal_due' || $state === 'period_ended') {
                // Keep an already issued renewal invoice attached to the moved period end (its period_start / due_at follow).
                $end = $set['current_period_end'];
                BillingInvoice::query()->where('kind', BillingInvoice::RENEWAL)->where('status', BillingInvoice::OPEN)
                    ->where('subscription_id', $sub->id)->update(['period_start' => $end, 'due_at' => $end,
                        'period_end' => BillingQuoteService::addInterval($end, $sub->scheduled_interval ?? $sub->billing_interval)]);
            }
            DB::table('subscriptions')->where('id', $sub->id)->where('tenant_id', $sub->tenant_id)->update($set + ['updated_at' => $now]);
            FeatureGate::forget($sub->tenant_id);
        }));

        dispatch_sync(new ProcessSubscriptionJob($tenantId));

        return BillingChangeController::json(['data' => PlanPresenter::subscription($plans->current()->load('plan'))]);
    }
}
