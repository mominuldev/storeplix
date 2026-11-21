<?php

namespace Tests\Feature\Phase3;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** Cross-tenant isolation for themes, pages, navigation and media references (PHASE-3-CONTRACT §9 tenancy). */
#[Group('tenancy')]
class ContentTenancyTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    public function test_tenant_a_cannot_read_or_write_tenant_b_theme_pages_or_menus(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $storeA = $this->storeFor($tenantA, 'alpha');
        $storeB = $this->storeFor($tenantB, 'bravo');
        $pageB = $this->tenancy()->run($tenantB, fn () => StorePage::query()->where('store_id', $storeB->id)->where('slug', 'about')->value('id'));
        $headersA = $this->tenantHeaders($userA, $tenantA);
        $base = "/api/v1/stores/{$storeB->id}";

        $this->assertTenantIsolation($headersA, [
            ['GET', "{$base}/themes"],
            ['GET', "{$base}/themes/modern-commerce"],
            ['PUT', "{$base}/themes/modern-commerce/draft", ['config' => $this->defaultConfig(), 'base_revision' => 1]],
            ['POST', "{$base}/themes/modern-commerce/publish", ['draft_revision' => 1]],
            ['POST', "{$base}/themes/modern-commerce/discard"],
            ['POST', "{$base}/themes/modern-commerce/apply"],
            ['GET', "{$base}/pages"],
            ['POST', "{$base}/pages", ['title' => 'Pwned']],
            ['GET', "{$base}/pages/{$pageB}"],
            ['PATCH', "{$base}/pages/{$pageB}", ['revision' => 1, 'title' => 'Pwned']],
            ['DELETE', "{$base}/pages/{$pageB}"],
            ['GET', "{$base}/navigation"],
            ['PUT', "{$base}/navigation/main", ['items' => [], 'revision' => 1]],
            // B's page through A's own store path.
            ['GET', "/api/v1/stores/{$storeA->id}/pages/{$pageB}"],
            ['PATCH', "/api/v1/stores/{$storeA->id}/pages/{$pageB}", ['revision' => 1, 'title' => 'Pwned']],
            ['DELETE', "/api/v1/stores/{$storeA->id}/pages/{$pageB}"],
        ]);

        // Nothing of B changed; A's lists never contain B ids.
        $this->assertSame('About us', StorePage::withoutTenancy()->find($pageB)->title);
        $this->assertSame(1, StoreTheme::withoutTenancy()->where('store_id', $storeB->id)->value('draft_revision'));
        $ids = collect($this->flushHeaders()->withHeaders($headersA)->getJson("/api/v1/stores/{$storeA->id}/pages")->json('data'))->pluck('id');
        $this->assertNotContains($pageB, $ids);

        // X-Tenant-Id of B sent by A's user → 403 tenant_forbidden.
        $this->flushHeaders()->withHeaders(['X-Tenant-Id' => $tenantB->id] + $headersA)
            ->getJson("{$base}/pages")->assertForbidden();
    }

    public function test_models_are_tenant_scoped(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantA, 'alpha');
        $storeB = $this->storeFor($tenantB, 'bravo');

        $this->tenancy()->run($tenantA, function () use ($storeB) {
            foreach ([StoreTheme::class, StorePage::class, StoreNavigation::class] as $model) {
                $this->assertGreaterThan(0, $model::query()->count(), $model);
                $this->assertSame(0, $model::query()->where('store_id', $storeB->id)->count(), $model);
            }
        });
    }

    public function test_foreign_media_and_pages_are_rejected_as_references(): void
    {
        Storage::fake('public');
        [$userA, $tenantA] = $this->merchant();
        [$userB, $tenantB] = $this->merchant();
        $storeA = $this->storeFor($tenantA, 'alpha');
        $storeB = $this->storeFor($tenantB, 'bravo');
        $mediaB = $this->uploadMedia($userB, $tenantB);
        $pageB = $this->tenancy()->run($tenantB, fn () => StorePage::query()->where('store_id', $storeB->id)->value('id'));
        $headersA = $this->tenantHeaders($userA, $tenantA);

        $config = $this->defaultConfig();
        $config['sections'][0]['settings']['imageMediaId'] = $mediaB;
        $this->saveDraft($headersA, $storeA, $config, 1)
            ->assertStatus(422)->assertJsonPath('error.details', ['config.sections.0.settings.imageMediaId' => ['Unknown image.']]);

        $this->flushHeaders()->withHeaders($headersA)->postJson("/api/v1/stores/{$storeA->id}/pages", [
            'title' => 'X', 'body' => [['id' => 'img0000001', 'type' => 'image', 'media_id' => $mediaB]],
        ])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body.0.media_id']]]);
        $this->flushHeaders()->withHeaders($headersA)->postJson("/api/v1/stores/{$storeA->id}/pages", [
            'title' => 'X', 'seo' => ['share_image_media_id' => $mediaB],
        ])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['seo.share_image_media_id']]]);
        $this->flushHeaders()->withHeaders($headersA)->patchJson("/api/v1/stores/{$storeA->id}/settings", ['seo' => ['share_image_media_id' => $mediaB]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['seo.share_image_media_id']]]);

        $this->flushHeaders()->withHeaders($headersA)->putJson("/api/v1/stores/{$storeA->id}/navigation/main", ['revision' => 1, 'items' => [
            ['id' => 'link000001', 'label' => 'B', 'link' => ['type' => 'page', 'page_id' => $pageB]],
        ]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items.0.link.page_id']]]);

        // B's media can't be listed or deleted by A.
        $this->assertNotContains($mediaB, $this->flushHeaders()->withHeaders($headersA)->getJson('/api/v1/media')->json('data.*.id'));
        $this->flushHeaders()->withHeaders($headersA)->deleteJson("/api/v1/media/{$mediaB}")->assertNotFound();
    }

    public function test_storefront_never_serves_another_stores_pages_or_drafts(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [$userB, $tenantB] = $this->merchant();
        $storeA = $this->storeFor($tenantA, 'alpha');
        $storeB = $this->storeFor($tenantB, 'bravo');

        $this->flushHeaders()->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->postJson("/api/v1/stores/{$storeB->id}/pages", ['title' => 'Only in B', 'slug' => 'only-b', 'status' => 'published'])->assertCreated();
        $config = $this->defaultConfig();
        $config['sections'][0]['settings']['heading'] = 'Secret B draft';
        $this->saveDraft($this->tenantHeaders($userB, $tenantB), $storeB, $config, 1)->assertOk();

        $this->storefront('/pages/only-b', 'alpha.storeplix.test')->assertNotFound()->assertJsonPath('error.code', 'page_not_found');
        $this->storefront('/pages/only-b', 'bravo.storeplix.test')->assertOk();
        $this->assertNotContains('only-b', $this->storefront('/pages', 'alpha.storeplix.test')->json('data.*.slug'));

        // B's preview token with host A → A's public view only.
        $tokenB = $this->previewToken($storeB);
        $this->storefront('/config', 'alpha.storeplix.test', $tokenB)
            ->assertJsonPath('data.preview', false)
            ->assertJsonPath('data.store.id', $storeA->id)
            ->assertJsonPath('data.theme.sections.0.settings.heading', 'Little things,');
        $this->storefront('/pages/privacy', 'alpha.storeplix.test', $tokenB)->assertNotFound();
        $this->storefront('/pages/only-b', 'alpha.storeplix.test', $tokenB)->assertNotFound();
        $this->assertStringNotContainsString('Secret B draft', $this->storefront('/config', 'alpha.storeplix.test', $tokenB)->getContent());
    }
}
