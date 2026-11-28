<?php

declare(strict_types=1);

namespace App\Domain\Ai\Http\Controllers;

use App\Domain\Admin\SmsCredits\Http\Requests\AdminSmsCreditAdjustRequest;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Ai\Credits\AiCreditPresenter;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;

/**
 * PHASE-8-9D §10.4 (P89D-35, S347): a merchant's AI credits for Store Plix staff. Reads `view_merchants`, adjust
 * `manage_billing` (route middleware). Every call runs inside TenantContext::run($tenant) — the tenant comes from the
 * path, never from X-Tenant-Id; unknown tenant → 404.
 */
final class AdminAiCreditController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AiCreditCharger $credits,
    ) {}

    public function show(string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;

        // cross-tenant: AI credit support — staff read of one merchant's AI credits.
        return AdminPresenter::json(['data' => $this->context->run($tenantId, fn () => AiCreditPresenter::admin($this->credits, $tenantId))]);
    }

    public function ledger(Request $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;

        // cross-tenant: AI credit support — staff read of one merchant's AI credit ledger.
        return AdminPresenter::json($this->context->run($tenantId, fn () => AiCreditPresenter::ledgerPage($request, $tenantId)));
    }

    /** POST /admin/tenants/{tenant}/ai-credits/adjust — bonus ±1…100,000 (never 0), reason 5–500, Idempotency-Key. */
    public function adjust(Request $request, string $tenant): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $input = Validator::make($request->all(), [
            'credits' => ['required', 'integer', 'between:-100000,100000', 'not_in:0'],
            'reason' => AdminSmsCreditAdjustRequest::reasonRules(),
        ])->validate();
        $credits = (int) $input['credits'];
        $reason = trim((string) $input['reason']);
        $hash = hash('sha256', (string) json_encode(['credits' => $credits, 'reason' => $reason]));
        $staff = AdminBillingController::staff($request);

        // cross-tenant: AI credit adjustment — runs as the tenant with the staff user as the platform actor (P8-7).
        $body = $this->context->run($tenantId, function () use ($credits, $reason, $staff, $key, $hash, $tenantId) {
            $this->credits->adjust($credits, $reason, $staff, $key, $hash);

            return AiCreditPresenter::admin($this->credits, $tenantId);
        });

        return AdminPresenter::json(['data' => $body]);
    }
}
