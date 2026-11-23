<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http;

use App\Domain\Admin\Suspension\Mail\AdminNoticeMail;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\Requests\AdminChangePlanRequest;
use App\Domain\Admin\Tenants\Http\Requests\AdminExtendRequest;
use App\Domain\Admin\Tenants\Http\Requests\AdminQuoteRequest;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Billing\Http\Resources\PlanPresenter;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Ops\CompPlanChange;
use App\Domain\Billing\Ops\ExtendSubscription;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Billing\Ops\SchedulePlanChange;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * PHASE-8-1 §6.3 tenant billing writes (`manage_billing`, P8-13 / P8-14). Each one runs the shared Billing Action as
 * the tenant (TenantContext::run on the app connection, P8-7 / S78) with the staff user as the platform actor.
 */
class AdminBillingController
{
    public function __construct(private readonly TenantContext $context) {}

    /** POST /admin/tenants/{tenant}/billing/quote — the Phase 7 quote (warnings) for the dialog; no side effects. */
    public function quote(AdminQuoteRequest $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $input = $request->validated();

        $quote = $this->context->run($tenantId, function () use ($input) {
            $target = PlanChangeService::targetPlan((string) $input['plan_code']);
            $current = FeatureGate::currentSubscription();
            if ($current === null) {
                return BillingQuoteService::quote($this->context->tenant(), app(PlanChangeService::class)->current(), $target, (string) $input['interval']);
            }
            // Staff changes are never charged (Q95): a past-due shop is quoted as if it were active, so a paid target
            // isn't refused with invoice_overdue.
            $basis = clone $current;
            if ($basis->status === Subscription::PAST_DUE) {
                $basis->status = Subscription::ACTIVE;
            }

            return BillingQuoteService::quote($this->context->tenant(), $basis, $target, (string) $input['interval']);
        });

        return AdminPresenter::json(['data' => BillingPresenter::quote($quote)]);
    }

    /** POST /admin/tenants/{tenant}/billing/change-plan — `now` = comp change, `next_renewal` = scheduled change. */
    public function changePlan(AdminChangePlanRequest $request, string $tenant, CompPlanChange $comp, SchedulePlanChange $schedule): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $input = $request->validated();
        $hash = hash('sha256', json_encode([$input['plan_code'], $input['interval'], $input['effective']]) ?: '');
        $cacheKey = "admin:change-plan:{$tenantId}:".hash('sha256', $key);

        $previous = Cache::get($cacheKey);
        if (is_array($previous)) {
            if ($previous['hash'] !== $hash) {
                throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
            }

            return AdminPresenter::json($previous['body'])->header('Idempotent-Replayed', 'true');
        }

        $actor = OpsActor::staff(self::staff($request), $request->reason());
        $subscription = $input['effective'] === 'now'
            ? $comp->handle($tenantId, (string) $input['plan_code'], (string) $input['interval'], $actor, staffChange: true)
            : $schedule->handle($tenantId, (string) $input['plan_code'], (string) $input['interval'], $actor);

        $body = ['data' => $this->context->run($tenantId, fn () => PlanPresenter::subscription($subscription->refresh()->load('plan')))];
        Cache::put($cacheKey, ['hash' => $hash, 'body' => $body], now()->addDay());

        if ($input['effective'] === 'now' && ($input['notify'] ?? true)) {
            AdminNoticeMail::sendToOwner($tenantId, AdminNoticeMail::PLAN_CHANGED, ['plan' => (string) $subscription->plan->name]);
        }

        return AdminPresenter::json($body);
    }

    /** POST /admin/tenants/{tenant}/subscription/extend (P8-14). */
    public function extend(AdminExtendRequest $request, string $tenant, ExtendSubscription $extend): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $subscription = $extend->handle($tenantId, (int) $request->validated('days'), OpsActor::staff(self::staff($request), $request->reason()));

        return AdminPresenter::json(['data' => $this->context->run($tenantId, fn () => PlanPresenter::subscription($subscription))]);
    }

    public static function staff(Request $request): User
    {
        $user = $request->user();

        return $user instanceof User ? $user : throw new ApiException(401, 'unauthenticated', 'Unauthenticated.');
    }
}
