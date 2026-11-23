<?php

declare(strict_types=1);

namespace App\Domain\Admin\Suspension\Http;

use App\Domain\Admin\Suspension\TenantSuspension;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\Http\AdminTenantController;
use App\Domain\Admin\Tenants\Http\Requests\AdminReactivateRequest;
use App\Domain\Admin\Tenants\Http\Requests\AdminSuspendRequest;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\Ops\OpsActor;
use Illuminate\Http\JsonResponse;

/** PHASE-8-1 §6.2 suspend / reactivate (`suspend`, P8-12). */
class SuspensionController
{
    public function __construct(private readonly TenantSuspension $suspension) {}

    public function suspend(AdminSuspendRequest $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $this->suspension->suspend($tenantId, (string) $request->validated('reason_code'),
            OpsActor::staff(AdminBillingController::staff($request), $request->reason()), (bool) $request->validated('notify', true));

        return AdminPresenter::json(['data' => AdminTenantController::detail($tenantId)]);
    }

    public function reactivate(AdminReactivateRequest $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $this->suspension->reactivate($tenantId, OpsActor::staff(AdminBillingController::staff($request), $request->reason()),
            (bool) $request->validated('notify', true));

        return AdminPresenter::json(['data' => AdminTenantController::detail($tenantId)]);
    }
}
