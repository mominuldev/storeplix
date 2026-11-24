<?php

namespace Tests\Feature\Stores;

use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

class StoreSettingsTest extends TestCase
{
    use RefreshDatabase;

    public function test_get_settings_shape(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'shop');

        $this->withHeaders($this->tenantHeaders($user, $tenant))->getJson("/api/v1/stores/{$store->id}/settings")
            ->assertOk()
            ->assertExactJsonStructure(['data' => [
                'store_id',
                'identity' => ['name', 'name_bn', 'slug', 'primary_domain', 'business_categories'],
                'branding' => ['logo', 'favicon', 'primary_color', 'secondary_color'],
                'contact' => ['phone', 'email', 'whatsapp', 'support_hours'],
                'social' => ['facebook', 'instagram', 'youtube'],
                'address' => ['street', 'division', 'district', 'area', 'postcode', 'use_for_returns'],
                'region' => ['country', 'currency', 'currency_locked', 'timezone'],
                'seo' => ['title', 'description', 'share_image', 'hide_from_search'],
                'commerce' => [
                    'checkout' => ['cod_enabled', 'cod_advance'], 'order_prefix', 'next_order_number', 'tax' => ['display', 'rate_bps', 'bin'], 'invoice' => ['footer'],
                    'notifications' => ['new_order_email', 'sms_language', 'customer_sms' => ['order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link']],
                ],
                'updated_at',
            ]])
            ->assertJsonPath('data.commerce.order_prefix', 'SH')
            ->assertJsonPath('data.commerce.next_order_number', 'SH-1001')
            ->assertJsonPath('data.identity.primary_domain', 'shop.storeplix.test')
            ->assertJsonPath('data.branding.primary_color', '#0846c2')
            ->assertJsonPath('data.address.use_for_returns', true)
            ->assertJsonPath('data.region.timezone', 'Asia/Dhaka');
    }

    public function test_partial_update_changes_only_given_keys(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_ADMIN);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $url = "/api/v1/stores/{$store->id}/settings";

        $this->withHeaders($headers)->patchJson($url, [
            'identity' => ['name' => '  Rahim Fashion ', 'name_bn' => 'রহিম', 'business_categories' => ['fashion', 'beauty']],
            'branding' => ['primary_color' => '#AABBCC'],
            'contact' => ['phone' => '01712345678', 'whatsapp' => '+14155550123', 'email' => 'Shop@Example.com', 'support_hours' => '10am–8pm'],
            'social' => ['facebook' => 'https://www.facebook.com/rahim', 'instagram' => 'https://instagram.com/rahim'],
            'address' => ['division' => 'Dhaka', 'postcode' => '1212', 'use_for_returns' => false],
            'region' => ['currency' => 'usd', 'timezone' => 'Asia/Dhaka'],
        ])->assertOk()
            ->assertJsonPath('data.identity.name', 'Rahim Fashion')
            ->assertJsonPath('data.identity.business_categories', ['fashion', 'beauty'])
            ->assertJsonPath('data.branding.primary_color', '#aabbcc')
            ->assertJsonPath('data.branding.secondary_color', '#ff7a00')
            ->assertJsonPath('data.contact.phone', '+8801712345678')
            ->assertJsonPath('data.contact.whatsapp', '+14155550123')
            ->assertJsonPath('data.contact.email', 'shop@example.com')
            ->assertJsonPath('data.social.youtube', null)
            ->assertJsonPath('data.address.use_for_returns', false)
            ->assertJsonPath('data.region.currency', 'USD');

        // Second patch: only contact.email cleared; everything else untouched.
        $this->withHeaders($headers)->patchJson($url, ['contact' => ['email' => null]])
            ->assertOk()
            ->assertJsonPath('data.contact.email', null)
            ->assertJsonPath('data.contact.phone', '+8801712345678')
            ->assertJsonPath('data.social.facebook', 'https://www.facebook.com/rahim')
            ->assertJsonPath('data.address.postcode', '1212');

        // P3-8: the colour shortcut writes the active theme's draft AND published config.
        $theme = StoreTheme::withoutTenancy()->where('is_active', true)->sole();
        $this->assertSame('#aabbcc', $theme->draft_config['settings']['primaryColor']);
        $this->assertSame('#aabbcc', $theme->published_config['settings']['primaryColor']);

        $log = $this->platformQuery(AuditLog::class)->where('action', 'store.settings_updated')->oldest('id')->first();
        $this->assertContains('contact.phone', $log->meta['changes']);
        $this->assertStringNotContainsString('01712345678', json_encode($log->meta));
        $this->assertStringNotContainsString('shop@example.com', json_encode($log->meta));
    }

    public function test_validation_rules(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $url = "/api/v1/stores/{$store->id}/settings";

        $invalid = [
            'identity.name' => ['identity' => ['name' => 'X']],
            'identity.business_categories.0' => ['identity' => ['business_categories' => ['cars']]],
            'branding.primary_color' => ['branding' => ['primary_color' => 'red']],
            'contact.phone' => ['contact' => ['phone' => '0123']],
            'contact.email' => ['contact' => ['email' => 'nope']],
            'social.facebook' => ['social' => ['facebook' => 'https://evil.com/facebook.com']],
            'social.instagram' => ['social' => ['instagram' => 'http://instagram.com/x']],
            'address.division' => ['address' => ['division' => 'Gotham']],
            'address.postcode' => ['address' => ['postcode' => '12']],
            'region.currency' => ['region' => ['currency' => 'EUR']],
            'region.timezone' => ['region' => ['timezone' => 'Mars/Base']],
            'identity' => ['identity' => ['slug' => 'new-slug']], // slug not editable here
        ];

        foreach ($invalid as $field => $body) {
            $this->withHeaders($headers)->patchJson($url, $body)
                ->assertStatus(422)
                ->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => [$field]]]);
        }

        // Non-BD address: free text division/postcode allowed.
        $this->withHeaders($headers)->patchJson($url, ['region' => ['country' => 'us'], 'address' => ['division' => 'California', 'postcode' => '94105-1234']])
            ->assertOk()->assertJsonPath('data.region.country', 'US');
    }

    #[Group('tenancy')]
    public function test_staff_cannot_change_settings(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        $store = $this->storeFor($tenant, 'shop');

        $this->withHeaders($this->tenantHeaders($staff, $tenant))
            ->patchJson("/api/v1/stores/{$store->id}/settings", ['identity' => ['name' => 'Hacked']])
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');

        $this->assertSame('Shop Store', Store::withoutTenancy()->find($store->id)->name);
    }

    #[Group('tenancy')]
    public function test_settings_of_another_tenant_are_404_and_foreign_media_is_rejected(): void
    {
        Storage::fake('public');
        [$userA, $tenantA] = $this->merchant();
        [$userB, $tenantB] = $this->merchant();
        $storeA = $this->storeFor($tenantA, 'alpha');
        $storeB = $this->storeFor($tenantB, 'bravo');

        $mediaB = $this->flushHeaders()->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->post('/api/v1/media', ['file' => UploadedFile::fake()->createWithContent('l.png', $this->imageBytes(100, 100)), 'purpose' => 'logo'], ['Accept' => 'application/json'])
            ->assertCreated()->json('data.id');

        $headersA = $this->tenantHeaders($userA, $tenantA);
        $this->flushHeaders()->withHeaders($headersA)->getJson("/api/v1/stores/{$storeB->id}/settings")->assertNotFound();
        $this->withHeaders($headersA)->patchJson("/api/v1/stores/{$storeB->id}/settings", ['identity' => ['name' => 'Pwned']])->assertNotFound();

        $this->withHeaders($headersA)->patchJson("/api/v1/stores/{$storeA->id}/settings", ['branding' => ['logo_media_id' => $mediaB]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['branding.logo_media_id']]]);

        // Purpose must match too: a logo can't be used as favicon.
        $this->flushHeaders()->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->patchJson("/api/v1/stores/{$storeB->id}/settings", ['branding' => ['favicon_media_id' => $mediaB]])
            ->assertStatus(422);
    }

    public function test_storefront_config_exposes_branding_contact_and_social_only(): void
    {
        Storage::fake('public');
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $upload = fn (string $purpose, int $size) => $this->flushHeaders()->withHeaders($headers)
            ->post('/api/v1/media', ['file' => UploadedFile::fake()->createWithContent('i.png', $this->imageBytes($size, $size)), 'purpose' => $purpose], ['Accept' => 'application/json'])
            ->json('data.id');
        $logo = $upload('logo', 400);
        $favicon = $upload('favicon', 512);

        $this->flushHeaders()->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", [
            'branding' => ['logo_media_id' => $logo, 'favicon_media_id' => $favicon],
            'contact' => ['phone' => '01712345678'],
            'social' => ['youtube' => 'https://youtu.be/abc'],
            'address' => ['street' => 'Secret street 1'],
        ])->assertOk()->assertJsonPath('data.branding.logo.id', $logo)->assertJsonPath('data.branding.logo.width', 320);

        $config = $this->flushHeaders()->withHeaders(['X-Storefront-Key' => 'test-storefront-key', 'X-Storefront-Host' => 'shop.storeplix.test'])
            ->getJson('/api/v1/storefront/config')->assertOk();

        $config->assertJsonPath('data.contact.phone', '+8801712345678')
            ->assertJsonPath('data.social.youtube', 'https://youtu.be/abc');
        $this->assertStringEndsWith("/media/{$logo}/w320.webp", $config->json('data.store.logo_url'));
        $this->assertStringEndsWith("/media/{$favicon}/favicon_32.png", $config->json('data.store.favicon_url'));
        $this->assertStringEndsWith("/media/{$favicon}/apple_180.png", $config->json('data.store.icons.apple_touch'));
        $this->assertStringEndsWith("/media/{$favicon}/icon_512.png", $config->json('data.store.icons.icon_512'));
        $this->assertStringNotContainsString('Secret street', $config->getContent());
        // (Media URLs embed tenants/{tenant_id}/ by contract §1.5; no tenant id elsewhere.)
        $this->assertArrayNotHasKey('tenant_id', $config->json('data.store'));
    }
}
