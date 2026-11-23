<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Testing\TestResponse;

/** Phase 8.3 helpers: a Growth shop, custom roles through the API, members of a role. */
trait RoleFixtures
{
    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} owner, tenant, store, owner headers */
    protected function growthShop(string $slug = 'shop', string $plan = Plan::GROWTH): array
    {
        [$owner, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, $slug.strtolower(substr((string) $tenant->id, -6)));
        $this->planFor($tenant, $plan);

        return [$owner, $tenant, $store, $this->tenantHeaders($owner, $tenant)];
    }

    protected function planFor(Tenant $tenant, string $plan): void
    {
        $this->inTenant($tenant, fn () => Subscription::query()->update([
            'plan_id' => Plan::query()->where('code', $plan)->value('id'),
            'status' => Subscription::ACTIVE,
            'trial_ends_at' => null,
        ]));
        FeatureGate::forget($tenant->id);
    }

    /** @param list<string> $permissions */
    protected function createRole(array $h, string $name, array $permissions, ?string $description = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/roles', array_filter([
            'name' => $name, 'description' => $description, 'permissions' => $permissions,
        ], fn ($v) => $v !== null));
    }

    /** @param list<string> $permissions */
    protected function customRole(array $h, string $name, array $permissions): string
    {
        return $this->createRole($h, $name, $permissions)->assertCreated()->json('data.id');
    }

    /** A new user who is a member of $tenant with the role. @return array{0: User, 1: array<string, string>, 2: TenantUser} */
    protected function memberWithRole(Tenant $tenant, string $roleId): array
    {
        $user = User::factory()->create();
        $membership = $this->inTenant($tenant, fn () => TenantUser::query()->create(['tenant_id' => $tenant->id, 'user_id' => $user->id, 'role_id' => $roleId]));

        return [$user, $this->tenantHeaders($user, $tenant), $membership];
    }

    /** A new member with a system role kind. @return array{0: User, 1: array<string, string>} */
    protected function memberAs(Tenant $tenant, string $kind): array
    {
        [$user] = $this->merchant($kind, $tenant);

        return [$user, $this->tenantHeaders($user, $tenant)];
    }

    protected function systemRoleId(Tenant $tenant, string $key): string
    {
        return (string) $this->platformTable('roles')->where('tenant_id', $tenant->id)->where('key', $key)->value('id');
    }

    protected function roleRow(Tenant $tenant, string $id): ?Role
    {
        return $this->platformQuery(Role::class)->where('tenant_id', $tenant->id)->whereKey($id)->first();
    }

    protected function membershipOf(User $user, Tenant $tenant): TenantUser
    {
        return $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('user_id', $user->id)->sole();
    }

    /** @param array<string, mixed> $body */
    protected function call2(array $h, string $method, string $uri, array $body = []): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h)->json($method, $uri, $body);
    }
}
