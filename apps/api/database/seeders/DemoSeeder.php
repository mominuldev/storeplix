<?php

namespace Database\Seeders;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Database\Seeder;

/**
 * Dev seed per docs/development/AGENT-CONTRACTS.md:
 * demo@storeplix.test / password, tenant "Demo", store "demo",
 * domains demo.{PLATFORM_DOMAIN} (primary) and demo.localhost. Idempotent.
 */
class DemoSeeder extends Seeder
{
    public function run(StoreProvisioner $provisioner): void
    {
        $user = User::query()->firstOrCreate(
            ['email' => 'demo@storeplix.test'],
            ['name' => 'Demo Merchant', 'phone' => '+8801700000000', 'password' => 'password', 'email_verified_at' => now()],
        );

        $tenant = Tenant::query()->firstOrCreate(['name' => 'Demo']);

        TenantUser::query()->firstOrCreate(
            ['tenant_id' => $tenant->id, 'user_id' => $user->id],
            ['role' => TenantUser::ROLE_OWNER],
        );

        if (Store::withoutTenancy()->where('slug', 'demo')->exists()) {
            return;
        }

        $provisioner->provision($tenant, [
            'name' => 'Demo Store',
            'slug' => 'demo',
            'status' => Store::STATUS_ACTIVE,
            'country' => 'BD',
            'currency' => 'BDT',
            'business_category' => 'fashion',
        ], extraPlatformHosts: ['demo.localhost']);
    }
}
