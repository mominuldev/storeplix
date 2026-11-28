<?php

declare(strict_types=1);

namespace App\Domain\Ai\Http\Controllers;

use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Ai\Credits\AiCreditPresenter;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-9D §10.1 / §10.3 tenant-level `/billing/ai-credits…`: summary (`products.edit | integrations.manage |
 * billing.view`) and ledger (`billing.view | integrations.manage`); the route `perm:` middleware is the gate.
 */
final class AiCreditController
{
    public function __construct(
        private readonly AiCreditCharger $credits,
        private readonly TenantContext $context,
    ) {}

    public function show(): JsonResponse
    {
        return BillingChangeController::json(['data' => $this->credits->summary()]);
    }

    public function ledger(Request $request): JsonResponse
    {
        return BillingChangeController::json(AiCreditPresenter::ledgerPage($request, $this->context->requireId()));
    }
}
