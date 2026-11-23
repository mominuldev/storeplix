<?php

declare(strict_types=1);

namespace App\Domain\Admin\Suspension;

use App\Domain\Admin\Suspension\Mail\AdminNoticeMail;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-1 P8-12 / §4.1: suspend and reactivate a shop (tenant + its one store).
 *
 * The store row is a tenant row (app connection, RLS, inside TenantContext::run); the tenant row is a platform table
 * updated on the admin connection. Suspend writes the store first, then the tenant; reactivate the reverse, so a crash
 * in between leaves a mismatch that `admin:check-suspensions` repairs from the tenant status (the source of truth).
 * Store saves go through Eloquent: StoreObserver forgets the host cache and StorefrontRevalidationObserver dispatches
 * the ISR revalidation for every host of the store; FeatureGate's tenant cache is busted here.
 */
final class TenantSuspension
{
    public const REASON_CODES = ['unpaid', 'fraud', 'terms_violation', 'merchant_request', 'other'];

    public function __construct(
        private readonly TenantContext $context,
        private readonly StorefrontResolver $resolver,
    ) {}

    /** @throws ApiException 409 invalid_state_transition when already suspended */
    public function suspend(string $tenantId, string $reasonCode, OpsActor $actor, bool $notify = true): void
    {
        $tenant = self::tenant($tenantId);
        if ($tenant->status === Tenant::STATUS_SUSPENDED) {
            throw new ApiException(409, 'invalid_state_transition', 'This shop is already suspended.');
        }

        $this->context->run($tenantId, fn () => DB::transaction(function () use ($tenant, $reasonCode, $actor, $notify) {
            $this->suspendStore();
            $actor->audit('tenant.suspended', $tenant, ['reason_code' => $reasonCode, 'reason' => $actor->reason, 'notify' => $notify]);
        }));
        // cross-tenant: admin suspension (tenants is a platform table)
        PlatformDb::connection()->table('tenants')->where('id', $tenantId)->update([
            'status' => Tenant::STATUS_SUSPENDED, 'suspended_at' => now(), 'suspension_reason_code' => $reasonCode,
            'suspended_by' => $actor->staff?->id, 'updated_at' => now(),
        ]);
        $this->bust($tenantId);
        if ($notify) {
            AdminNoticeMail::sendToOwner($tenantId, AdminNoticeMail::SUSPENDED);
        }
    }

    /** @throws ApiException 409 invalid_state_transition when the tenant is active */
    public function reactivate(string $tenantId, OpsActor $actor, bool $notify = true): void
    {
        $tenant = self::tenant($tenantId);
        if ($tenant->status !== Tenant::STATUS_SUSPENDED) {
            throw new ApiException(409, 'invalid_state_transition', 'This shop is not suspended.');
        }

        // cross-tenant: admin reactivation (tenant first, then the store)
        PlatformDb::connection()->table('tenants')->where('id', $tenantId)->update([
            'status' => Tenant::STATUS_ACTIVE, 'suspended_at' => null, 'suspension_reason_code' => null, 'suspended_by' => null,
            'updated_at' => now(),
        ]);
        $this->context->run($tenantId, fn () => DB::transaction(function () use ($tenant, $actor, $notify) {
            $restored = $this->restoreStore();
            $actor->audit('tenant.reactivated', $tenant, ['reason' => $actor->reason, 'notify' => $notify, 'store_status' => $restored]);
        }));
        $this->bust($tenantId);
        if ($notify) {
            AdminNoticeMail::sendToOwner($tenantId, AdminNoticeMail::REACTIVATED);
        }
    }

    /** Store → suspended, remembering draft/active. Call inside the tenant. Returns false when there was nothing to do. */
    public function suspendStore(): bool
    {
        $store = Store::query()->lockForUpdate()->first();
        if ($store === null || $store->status === Store::STATUS_SUSPENDED) {
            return false;
        }
        $store->forceFill(['status_before_suspension' => $store->status, 'status' => Store::STATUS_SUSPENDED])->save();

        return true;
    }

    /** Store → the status it had before (draft stays draft: Coming soon). Call inside the tenant. */
    public function restoreStore(): ?string
    {
        $store = Store::query()->lockForUpdate()->first();
        if ($store === null || $store->status !== Store::STATUS_SUSPENDED) {
            return $store?->status;
        }
        $to = in_array($store->status_before_suspension, [Store::STATUS_DRAFT, Store::STATUS_ACTIVE], true)
            ? $store->status_before_suspension : Store::STATUS_ACTIVE;
        $store->forceFill(['status' => $to, 'status_before_suspension' => null])->save();

        return $to;
    }

    /** Tenant cache (plan), host cache and storefront revalidation after commit. */
    public function bust(string $tenantId): void
    {
        FeatureGate::forget($tenantId);
        $this->context->run($tenantId, fn () => StoreDomain::query()->pluck('hostname')
            ->each(fn (string $host) => $this->resolver->forget($host)));
    }

    private static function tenant(string $tenantId): Tenant
    {
        // cross-tenant: admin suspension target
        return PlatformDb::reroute(Tenant::query())->findOrFail($tenantId);
    }
}
