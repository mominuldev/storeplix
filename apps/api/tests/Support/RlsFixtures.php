<?php

namespace Tests\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Phase 5b RLS helpers (PHASE-5B-CONTRACT §2.6). The `rls` group runs only with TENANCY_RLS=true on Postgres as
 * storeplix_app (CI `api-rls`, where a skip FAILS the job); everywhere else it skips.
 */
trait RlsFixtures
{
    use CommerceFixtures;

    protected function requireRls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
    }

    /**
     * Two live shops with one order each.
     *
     * @return array{a: array{user: User, tenant: Tenant, store: Store, headers: array<string, string>, order: string, variant: string}, b: array{user: User, tenant: Tenant, store: Store, headers: array<string, string>, order: string, variant: string}}
     */
    protected function twoTenantsWithOrders(): array
    {
        $out = [];
        foreach (['a', 'b'] as $k) {
            [$user, $tenant, $store, $h] = $this->liveShop('rls'.$k);
            [, $variant] = $this->stocked($h, $store, 1000, 20);
            $number = $this->placeOrder($store, $variant)->json('data.order.number');
            $order = $this->inTenant($tenant, fn () => Order::query()->where('number', $number)->value('id'));
            $out[$k] = ['user' => $user, 'tenant' => $tenant, 'store' => $store, 'headers' => $h, 'order' => (string) $order, 'variant' => (string) $variant];
        }

        return $out;
    }

    /** Sets the raw GUCs on the app connection (no TenantContext). */
    protected function setGuc(?string $tenantId, ?string $userId = null): void
    {
        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', ?, false)", [$tenantId ?? '', $userId ?? '']);
    }

    protected function guc(string $name = 'app.tenant_id'): string
    {
        return (string) DB::selectOne('select current_setting(?, true) as v', [$name])->v;
    }

    /** Runs $fn and returns the SQLSTATE it failed with (null when it succeeded). */
    protected function sqlState(callable $fn): ?string
    {
        try {
            $fn();
        } catch (QueryException $e) {
            return (string) ($e->errorInfo[0] ?? $e->getCode());
        }

        return null;
    }
}
