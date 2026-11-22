<?php

namespace Database\Seeders;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Artisan;

/**
 * Dev seed (AGENT-CONTRACTS + Phase 2): demo@storeplix.test / password, phone 8801700000000 (verified).
 * Tenant "Demo" (14-day Starter trial via TenantCreated),
 * store "demo" with domains demo.{PLATFORM_DOMAIN} (primary) and demo.localhost, public contact
 * and social links. Logo/favicon URLs derive from media, so none are seeded. Idempotent.
 * Phase 3: stores:ensure-content gives existing stores their default theme, pages and menus.
 * Phase 4: DemoCatalogSeeder adds 3 categories, 8 active products and 5 customers (idempotent).
 */
class DemoSeeder extends Seeder
{
    public function run(StoreProvisioner $provisioner, TenantContext $context): void
    {
        $user = User::query()->firstOrCreate(
            ['email' => 'demo@storeplix.test'],
            [
                'name' => 'Demo Merchant',
                'phone' => '8801700000000',
                'phone_verified_at' => now(),
                'password' => 'password',
                'email_verified_at' => now(),
                'password_changed_at' => now(),
            ],
        );

        $tenant = Tenant::query()->firstOrCreate(['name' => 'Demo']);

        TenantUser::query()->firstOrCreate(
            ['tenant_id' => $tenant->id, 'user_id' => $user->id],
            ['role' => TenantUser::ROLE_OWNER, 'joined_at' => now()],
        );

        if (! Store::withoutTenancy()->where('slug', 'demo')->exists()) {
            $provisioner->provision($tenant, [
                'name' => 'Demo Store',
                'slug' => 'demo',
                'status' => Store::STATUS_ACTIVE,
                'country' => 'BD',
                'currency' => 'BDT',
                'business_categories' => ['fashion'],
                'timezone' => 'Asia/Dhaka',
            ], extraPlatformHosts: ['demo.localhost']);
        }

        $context->run($tenant, fn () => StoreSetting::query()->firstOrFail()->fill([
            'contact_phone' => '+8801700000000',
            'contact_email' => 'hello@demo.storeplix.test',
            'whatsapp' => '+8801700000000',
            'support_hours' => '10am–8pm, Sat–Thu',
            'social_links' => [
                'facebook' => 'https://www.facebook.com/storeplix',
                'instagram' => 'https://www.instagram.com/storeplix',
                'youtube' => null,
            ],
            'business_address' => [
                'street' => 'House 1, Road 1', 'division' => 'Dhaka', 'district' => 'Dhaka',
                'area' => 'Gulshan', 'postcode' => '1212',
            ],
        ])->save());

        Artisan::call('stores:ensure-content', ['--store' => 'demo']);

        $this->call(DemoCatalogSeeder::class);
    }
}
