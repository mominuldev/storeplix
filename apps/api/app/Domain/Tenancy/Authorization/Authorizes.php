<?php

namespace App\Domain\Tenancy\Authorization;

use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Model;

/** Helpers for policies: role from the TenantContext + defence-in-depth tenant check. */
trait Authorizes
{
    protected function can(Permission $permission): bool
    {
        return $permission->grantedTo(app(TenantContext::class)->role());
    }

    protected function inCurrentTenant(Model $model): bool
    {
        $context = app(TenantContext::class);

        return $context->has() && $model->getAttribute('tenant_id') === $context->id();
    }
}
