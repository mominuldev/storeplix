<?php

namespace App\Domain\Tenancy\Concerns;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\Exceptions\TenantMismatchException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Scopes\TenantScope;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Marks a model as tenant-owned.
 *
 * - Every query is filtered by the current tenant (TenantScope).
 * - Querying without a tenant context THROWS (no silent "all tenants" reads).
 * - tenant_id is filled from the context on create; writing a row for another tenant throws.
 * - Platform/system code may opt out explicitly: Model::withoutTenancy()->...
 *
 * @mixin Model
 */
trait BelongsToTenant
{
    public static function bootBelongsToTenant(): void
    {
        static::addGlobalScope(new TenantScope);

        static::creating(function (Model $model): void {
            $context = app(TenantContext::class);

            if (! $context->has()) {
                if ($model->getAttribute('tenant_id') === null) {
                    throw new MissingTenantContextException(sprintf(
                        'Cannot create [%s] without a tenant context.', $model::class
                    ));
                }

                return; // explicit tenant_id from system code (e.g. seeders) running without context
            }

            if ($model->getAttribute('tenant_id') === null) {
                $model->setAttribute('tenant_id', $context->id());
            } elseif ($model->getAttribute('tenant_id') !== $context->id()) {
                throw new TenantMismatchException(sprintf(
                    'Refusing to create [%s] for a tenant other than the current context.', $model::class
                ));
            }
        });

        static::updating(function (Model $model): void {
            if ($model->isDirty('tenant_id') && $model->getOriginal('tenant_id') !== null) {
                throw new TenantMismatchException(sprintf('tenant_id of [%s] is immutable.', $model::class));
            }
        });
    }

    /** Explicit opt-out of tenant scoping for platform/system code. Use sparingly. */
    public static function withoutTenancy(): Builder
    {
        return static::query()->withoutGlobalScope(TenantScope::class);
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }
}
