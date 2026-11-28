<?php

declare(strict_types=1);

namespace App\Domain\Admin\SmsCredits\Http;

use App\Domain\Admin\SmsCredits\Http\Requests\AdminSmsCreditAdjustRequest;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Sms\Credits\SmsCreditLedgerQuery;
use App\Domain\Sms\Credits\SmsCreditPresenter;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-9A §10.3: a merchant's SMS credits for Store Plix staff. Reads `view_merchants`, adjust `manage_billing`
 * (P89A-18, S213). Every call runs inside TenantContext::run($tenant) (the tenant comes from the path, never from
 * X-Tenant-Id); unknown tenant → 404.
 */
class AdminSmsCreditController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly SmsCreditService $credits,
    ) {}

    public function show(string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;

        // cross-tenant: SMS credit adjustment — staff read of one merchant's credit account.
        return AdminPresenter::json(['data' => $this->context->run($tenantId, fn () => $this->body())]);
    }

    public function ledger(Request $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;

        // cross-tenant: SMS credit adjustment — staff read of one merchant's credit ledger.
        return AdminPresenter::json($this->context->run($tenantId, fn () => SmsCreditLedgerQuery::page($request, $tenantId)));
    }

    /** POST /admin/tenants/{tenant}/sms-credits/adjust — Idempotency-Key required; same key + body → same result. */
    public function adjust(AdminSmsCreditAdjustRequest $request, string $tenant): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $input = $request->validated();
        $credits = (int) $input['credits'];
        $reason = $request->reason();
        $hash = hash('sha256', (string) json_encode(['credits' => $credits, 'reason' => $reason]));
        $staff = AdminBillingController::staff($request);

        // cross-tenant: SMS credit adjustment — runs as the tenant with the staff user as the platform actor (P8-7).
        $body = $this->context->run($tenantId, function () use ($credits, $reason, $staff, $key, $hash) {
            $this->credits->adjust($credits, $reason, $staff, $key, $hash);

            return $this->body();
        });

        return AdminPresenter::json(['data' => $body]);
    }

    /** @return array<string, mixed> AdminSmsCredits */
    private function body(): array
    {
        return SmsCreditPresenter::admin($this->credits, $this->credits->netConsumedSince(FeatureGate::monthStart()));
    }
}
