<?php

namespace App\Domain\Tenancy\Scopes;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Scope;

class TenantScope implements Scope
{
    public function apply(Builder $builder, Model $model): void
    {
        $tenantId = app(TenantContext::class)->id();

        if ($tenantId === null) {
            throw new MissingTenantContextException(sprintf(
                'Query on tenant-owned model [%s] without tenant context. Resolve a tenant or use %s::withoutTenancy() in platform code.',
                $model::class,
                class_basename($model),
            ));
        }

        $builder->where($model->qualifyColumn('tenant_id'), $tenantId);
    }

    public function extend(Builder $builder): void
    {
        $builder->macro('withoutTenancy', fn (Builder $builder) => $builder->withoutGlobalScope($this));
    }
}
