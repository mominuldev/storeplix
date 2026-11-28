<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers;

use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Credits\SmsCreditLedgerQuery;
use App\Domain\Sms\Credits\SmsCreditPresenter;
use App\Domain\Sms\Credits\SmsCreditPurchaseService;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Http\Requests\SmsCreditPurchaseRequest;
use App\Domain\Sms\Http\Requests\SmsCreditSettingsRequest;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-9A §5, §10.1 tenant-level `/billing/sms-credits…`: account (billing.view | settings.manage |
 * integrations.manage), low-credit alert (billing.manage | settings.manage), ledger (billing.view), purchase
 * (billing.manage = owner; Idempotency-Key). The route `perm:` middleware is the gate; each action re-checks it.
 */
class SmsCreditController
{
    public function __construct(
        private readonly SmsCreditService $credits,
        private readonly TenantContext $context,
    ) {}

    public function show(): JsonResponse
    {
        $this->allow(Permission::BillingView, Permission::SettingsManage, Permission::IntegrationsManage);

        return BillingChangeController::json(['data' => SmsCreditPresenter::account($this->credits)]);
    }

    public function update(SmsCreditSettingsRequest $request): JsonResponse
    {
        $this->allow(Permission::BillingManage, Permission::SettingsManage);
        $threshold = $request->validated()['low_credit_threshold'];
        $account = $this->credits->setThreshold($threshold === null ? null : (int) $threshold, $request->user());

        return BillingChangeController::json(['data' => SmsCreditPresenter::account($this->credits, $account)]);
    }

    public function ledger(Request $request): JsonResponse
    {
        $this->allow(Permission::BillingView);

        return BillingChangeController::json(SmsCreditLedgerQuery::page($request, $this->context->requireId()));
    }

    public function purchase(Request $request, SmsCreditPurchaseService $purchases): JsonResponse
    {
        $this->allow(Permission::BillingManage);
        $key = BillingChangeController::idempotencyKey($request);
        $input = app(SmsCreditPurchaseRequest::class)->validated();
        $result = $purchases->purchase((string) $input['pack'], (string) $input['provider'], $key, $request->user());

        return BillingChangeController::json(['data' => [
            'invoice' => BillingPresenter::invoice($result['invoice']),
            'payment' => BillingPresenter::payment($result['payment']),
        ]], 201);
    }

    private function allow(Permission ...$permissions): void
    {
        if (! $this->context->allowsAny(...$permissions)) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        }
    }
}
