<?php

namespace Tests\Feature\Storefront;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class StorefrontContentTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    public function test_config_serves_published_theme_and_draft_only_with_preview(): void
    {
        Storage::fake('public');
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $used = $this->uploadMedia($user, $tenant);
        $unused = $this->uploadMedia($user, $tenant);

        $config = $this->defaultConfig();
        $config['sections'][0]['settings']['heading'] = 'Draft heading';
        $config['sections'][0]['settings']['imageMediaId'] = $used;
        $this->saveDraft($headers, $store, $config, 1)->assertOk()->assertJsonPath("data.media.{$used}.id", $used);

        $public = $this->storefront('/config', 'shop.storeplix.test')->assertOk()
            ->assertJsonPath('data.preview', false)
            ->assertJsonPath('data.theme.sections.0.settings.heading', 'Little things,');
        $this->assertSame([], (array) $public->json('data.media'));
        $this->assertStringNotContainsString('no-store', (string) $public->headers->get('Cache-Control'));

        $preview = $this->storefront('/config', 'shop.storeplix.test', $this->previewToken($store))->assertOk()
            ->assertJsonPath('data.preview', true)
            ->assertJsonPath('data.theme.sections.0.settings.heading', 'Draft heading')
            ->assertJsonPath("data.media.{$used}.id", $used)
            ->assertJsonStructure(['data' => ['media' => [$used => ['id', 'url', 'width', 'height', 'alt', 'srcset']]]])
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->assertArrayNotHasKey($unused, $preview->json('data.media'));

        // After publish the public config has the change and the referenced media.
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/publish'), ['draft_revision' => 2])->assertOk();
        $this->storefront('/config', 'shop.storeplix.test')
            ->assertJsonPath('data.theme.sections.0.settings.heading', 'Draft heading')
            ->assertJsonPath("data.media.{$used}.id", $used);
    }

    public function test_navigation_hides_unpublished_and_missing_pages_publicly(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $token = $this->previewToken($store);

        $public = $this->storefront('/config', 'shop.storeplix.test')->assertOk();
        $this->assertSame(['/', '/pages/about'], array_column($public->json('data.navigation.main.items'), 'href'));
        $this->assertSame(['/pages/contact'], array_column($public->json('data.navigation.help.items'), 'href'));
        $this->assertSame('Help', $public->json('data.navigation.help.title'));

        $preview = $this->storefront('/config', 'shop.storeplix.test', $token);
        $this->assertSame(['/pages/contact', '/pages/delivery-return', '/pages/privacy', '/pages/terms'], array_column($preview->json('data.navigation.help.items'), 'href'));

        // Parent pointing at a deleted page keeps its visible children; parent with none left is dropped.
        $this->tenancy()->run($tenant, function () use ($store) {
            $terms = StorePage::query()->where('slug', 'terms')->first();
            $privacy = StorePage::query()->where('slug', 'privacy')->first();
            $menu = StoreNavigation::query()->where('store_id', $store->id)->where('handle', 'footer')->first();
            $menu->items = [
                ['id' => 'gone000001', 'label' => 'Gone', 'link' => ['type' => 'page', 'page_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz'], 'children' => [
                    ['id' => 'kid0000001', 'label' => 'Kids', 'link' => ['type' => 'collection', 'handle' => 'kids']],
                ]],
                ['id' => 'draft00001', 'label' => 'Terms', 'link' => ['type' => 'page', 'page_id' => $terms->id], 'children' => [
                    ['id' => 'draft00002', 'label' => 'Privacy', 'link' => ['type' => 'page', 'page_id' => $privacy->id]],
                ]],
            ];
            $menu->save();
        });
        $footer = $this->storefront('/config', 'shop.storeplix.test')->json('data.navigation.footer.items');
        $this->assertSame([['id' => 'gone000001', 'label' => 'Gone', 'href' => '/collections/kids', 'children' => [
            ['id' => 'kid0000001', 'label' => 'Kids', 'href' => '/collections/kids', 'children' => []],
        ]]], $footer);
    }

    public function test_pages_index_and_page_by_slug(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $this->tenancy()->run($tenant, fn () => StorePage::query()->where('slug', 'terms')->update(['status' => 'hidden']));
        $token = $this->previewToken($store);

        $this->storefront('/pages', 'shop.storeplix.test')->assertOk()
            ->assertExactJsonStructure(['data' => ['*' => ['slug', 'updated_at']]])
            ->assertJsonPath('data.*.slug', ['about', 'contact']);
        $this->storefront('/pages', 'shop.storeplix.test', $token)->assertJsonPath('data.*.slug', ['about', 'contact']); // ignores preview

        $this->storefront('/pages/about', 'shop.storeplix.test')->assertOk()
            ->assertExactJsonStructure(['data' => ['id', 'slug', 'title', 'status', 'body', 'media', 'seo' => ['title', 'description', 'og_image_url'], 'updated_at']])
            ->assertJsonPath('data.title', 'About us');

        foreach (['privacy', 'terms', 'nope', 'BAD_slug', str_repeat('a', 81)] as $slug) {
            $this->storefront("/pages/{$slug}", 'shop.storeplix.test')->assertNotFound()->assertJsonPath('error.code', 'page_not_found');
        }
        $this->storefront('/pages/privacy', 'shop.storeplix.test', $token)->assertOk()->assertJsonPath('data.status', 'draft')
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->storefront('/pages/terms', 'shop.storeplix.test', $token)->assertOk()->assertJsonPath('data.status', 'hidden');
    }

    public function test_store_seo_settings(): void
    {
        Storage::fake('public');
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_ADMIN);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $share = $this->uploadMedia($user, $tenant, 'page_image', 1200);
        $logo = $this->uploadMedia($user, $tenant, 'logo', 200);

        $this->flushHeaders()->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['seo' => [
            'title' => '  Best kids shop ', 'description' => 'Everything for kids', 'share_image_media_id' => $share, 'hide_from_search' => true,
        ]])->assertOk()
            ->assertJsonPath('data.seo.title', 'Best kids shop')
            ->assertJsonPath('data.seo.share_image.id', $share)
            ->assertJsonPath('data.seo.hide_from_search', true);

        $config = $this->storefront('/config', 'shop.storeplix.test')
            ->assertJsonPath('data.seo.title', 'Best kids shop')
            ->assertJsonPath('data.seo.description', 'Everything for kids')
            ->assertJsonPath('data.seo.noindex', true);
        $this->assertStringContainsString("/media/{$share}/", $config->json('data.seo.og_image_url'));

        $bad = [
            'seo.title' => ['title' => str_repeat('x', 71)],
            'seo.description' => ['description' => str_repeat('x', 161)],
            'seo.share_image_media_id' => ['share_image_media_id' => $logo], // purpose must be page_image
            'seo.hide_from_search' => ['hide_from_search' => 'maybe'],
            'seo' => ['robots' => 'all'],
        ];
        foreach ($bad as $path => $seo) {
            $this->flushHeaders()->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['seo' => $seo])
                ->assertStatus(422)->assertJsonStructure(['error' => ['details' => [$path]]]);
        }

        // Clearing works and the audit log lists seo.* keys only.
        $this->flushHeaders()->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['seo' => ['title' => null, 'share_image_media_id' => null]])
            ->assertOk()->assertJsonPath('data.seo.title', null)->assertJsonPath('data.seo.share_image', null);
        $this->storefront('/config', 'shop.storeplix.test')->assertJsonPath('data.seo.title', 'Shop Store')->assertJsonPath('data.seo.og_image_url', null);
    }
}
