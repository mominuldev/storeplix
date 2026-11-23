<?php

namespace App\Domain\Tenancy\Authorization;

use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Model;

/** Helpers for policies: permissions from the TenantContext + defence-in-depth tenant check. */
trait Authorizes
{
    protected function can(Permission ...$anyOf): bool
    {
        return app(TenantContext::class)->allowsAny(...$anyOf);
    }

    /** A member of the current tenant (base access, PHASE-8-3 §3.1). */
    protected function member(): bool
    {
        return app(TenantContext::class)->has();
    }

    protected function inCurrentTenant(Model $model): bool
    {
        $context = app(TenantContext::class);

        return $context->has() && $model->getAttribute('tenant_id') === $context->id();
    }
}
