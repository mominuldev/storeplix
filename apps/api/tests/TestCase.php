<?php

namespace Tests;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    /**
     * @return array{0: User, 1: Tenant}
     */
    protected function merchant(string $role = TenantUser::ROLE_OWNER, ?Tenant $tenant = null): array
    {
        $user = User::factory()->create();
        $tenant ??= Tenant::factory()->create();

        TenantUser::query()->create(['tenant_id' => $tenant->id, 'user_id' => $user->id, 'role' => $role]);

        return [$user, $tenant];
    }

    /**
     * @param  list<string>  $extraHosts
     */
    protected function storeFor(Tenant $tenant, string $slug, array $extraHosts = [], string $status = Store::STATUS_ACTIVE): Store
    {
        return app(StoreProvisioner::class)->provision($tenant, [
            'name' => ucfirst($slug).' Store',
            'slug' => $slug,
            'status' => $status,
        ], $extraHosts);
    }

    /**
     * @return array<string, string>
     */
    protected function tenantHeaders(User $user, Tenant|string $tenant): array
    {
        return [
            'Authorization' => 'Bearer '.$user->createToken('test')->plainTextToken,
            'X-Tenant-Id' => $tenant instanceof Tenant ? $tenant->id : $tenant,
        ];
    }

    protected function tenancy(): TenantContext
    {
        return app(TenantContext::class);
    }
}
