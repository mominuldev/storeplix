<?php

namespace Tests\Feature\Themes;

use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Themes\Models\StoreTheme;
use App\Domain\Themes\ThemeRegistry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class StoreThemeTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    public function test_catalog_lists_registry_themes_for_any_role(): void
    {
        [$staff, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);

        $this->withHeaders($this->tenantHeaders($staff, $tenant))->getJson('/api/v1/themes')
            ->assertOk()
            ->assertJsonCount(9, 'data')
            ->assertJsonPath('data.0.code', 'modern-commerce')
            ->assertJsonPath('data.0.name', 'Gallery')
            ->assertJsonPath('data.0.status', 'available')
            ->assertJsonPath('data.4.tier', 'premium')
            ->assertJsonStructure(['data' => ['*' => ['code', 'name', 'description', 'version', 'status', 'tier', 'price_amount', 'currency', 'tags', 'is_new']]]);
    }

    public function test_store_theme_get_shape(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/themes")
            ->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'modern-commerce')
            ->assertJsonPath('data.0.is_active', true)
            ->assertJsonPath('data.0.has_unpublished_changes', false);

        $this->withHeaders($headers)->getJson($this->themeUrl($store))
            ->assertOk()
            ->assertExactJsonStructure(['data' => [
                'id', 'code', 'name', 'version', 'is_active', 'draft_revision', 'published_revision', 'has_unpublished_changes',
                'draft_updated_at', 'draft_updated_by', 'published_at', 'published_by', 'applied_at',
                'draft_config' => ['theme', 'version', 'settings', 'sections'], 'published_config' => ['theme', 'version', 'settings', 'sections'], 'media',
            ]])
            ->assertJsonPath('data.version', '1.1.0')
            ->assertJsonPath('data.draft_revision', 1)
            ->assertJsonPath('data.published_revision', 1)
            ->assertJsonPath('data.applied_at', null);

        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/themes/boutique")->assertNotFound();
    }

    public function test_draft_save_publish_and_discard_lifecycle(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_ADMIN);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        Queue::fake();

        $config = $this->defaultConfig();
        $config['sections'][0]['settings']['heading'] = '  Eid is here  ';
        $config['settings']['primaryColor'] = '#AA0000';

        $this->saveDraft($headers, $store, $config, 1)
            ->assertOk()
            ->assertJsonPath('data.draft_revision', 2)
            ->assertJsonPath('data.published_revision', 1)
            ->assertJsonPath('data.has_unpublished_changes', true)
            ->assertJsonPath('data.draft_config.sections.0.settings.heading', 'Eid is here') // trimmed
            ->assertJsonPath('data.draft_config.settings.primaryColor', '#aa0000') // normalised
            ->assertJsonPath('data.published_config.settings.primaryColor', '#0846c2')
            ->assertJsonPath('data.draft_updated_by.id', $user->id);
        Queue::assertNotPushed(RevalidateStorefront::class); // draft saves never revalidate

        // Public storefront still serves the published copy.
        $this->storefront('/config', 'shop.storeplix.test')->assertJsonPath('data.theme.settings.primaryColor', '#0846c2');

        // Stale base revision → 409.
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');

        // Publish with a stale draft revision → 409; with the current one → copies draft and revalidates.
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/publish'), ['draft_revision' => 1])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/publish'), ['draft_revision' => 2])
            ->assertOk()
            ->assertJsonPath('data.published_revision', 2)
            ->assertJsonPath('data.has_unpublished_changes', false)
            ->assertJsonPath('data.published_config.settings.primaryColor', '#aa0000')
            ->assertJsonPath('data.published_by.id', $user->id);
        Queue::assertPushed(RevalidateStorefront::class, fn ($job) => $job->storeId === $store->id);
        $this->storefront('/config', 'shop.storeplix.test')->assertJsonPath('data.theme.sections.0.settings.heading', 'Eid is here');

        // Publishing an unchanged draft is idempotent.
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/publish'), ['draft_revision' => 2])->assertOk();

        // Discard restores the published copy and bumps draft_revision, without revalidating.
        $changed = $config;
        $changed['settings']['primaryColor'] = '#00aa00';
        $this->saveDraft($headers, $store, $changed, 2)->assertOk()->assertJsonPath('data.draft_revision', 3);
        $this->travel(3)->seconds();
        Queue::fake();
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/discard'))
            ->assertOk()
            ->assertJsonPath('data.draft_revision', 4)
            ->assertJsonPath('data.draft_config.settings.primaryColor', '#aa0000')
            ->assertJsonPath('data.has_unpublished_changes', false);
        Queue::assertNotPushed(RevalidateStorefront::class);

        $actions = AuditLog::query()->where('subject_type', 'store_theme')->pluck('action')->all();
        $this->assertContains('theme.published', $actions);
        $this->assertContains('theme.discarded', $actions);
        $this->assertSame(['code' => 'modern-commerce', 'revision' => 2], AuditLog::query()->where('action', 'theme.published')->first()->meta);
    }

    public function test_discard_without_published_copy_and_publish_of_inactive_theme_are_409(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $this->tenancy()->run($tenant, fn () => StoreTheme::query()->where('store_id', $store->id)->update(['published_config' => null, 'published_revision' => null]));
        $this->withHeaders($headers)->postJson($this->themeUrl($store, '/discard'))->assertStatus(409)->assertJsonPath('error.code', 'nothing_published');

        // An installed but inactive theme can't be published in Phase 3.
        $this->tenancy()->run($tenant, fn () => StoreTheme::query()->create([
            'store_id' => $store->id, 'theme_code' => 'boutique', 'theme_version' => '1.1.0', 'draft_config' => $this->defaultConfig(),
        ]));
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/boutique/publish", ['draft_revision' => 1])
            ->assertStatus(409)->assertJsonPath('error.code', 'theme_not_active');
    }

    public function test_apply_sets_applied_at_and_rejects_unavailable_themes(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        Queue::fake();

        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/boutique/apply")
            ->assertStatus(409)->assertJsonPath('error.code', 'theme_unavailable');
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/festive/apply") // premium
            ->assertStatus(409)->assertJsonPath('error.code', 'theme_unavailable');
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/no-such-theme/apply")->assertNotFound();
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/Bad_Code/apply")->assertNotFound();

        $this->withHeaders($headers)->postJson($this->themeUrl($store, '/apply'))
            ->assertOk()
            ->assertJsonPath('data.is_active', true)
            ->assertJsonPath('data.code', 'modern-commerce');
        $this->assertNotNull(StoreTheme::withoutTenancy()->where('store_id', $store->id)->value('applied_at'));
        Queue::assertPushed(RevalidateStorefront::class);
        $this->assertTrue(AuditLog::query()->where('action', 'theme.applied')->exists());
    }

    public function test_apply_of_a_new_theme_carries_brand_settings_over(): void
    {
        // Only one theme is implemented, so make a second, available copy of it for this test.
        $root = storage_path('framework/testing/themes-'.uniqid());
        $src = resource_path('themes');
        mkdir("{$root}/second", 0777, true);
        mkdir("{$root}/modern-commerce", 0777, true);
        foreach (['schema.v1.json', 'defaults.json', 'manifest.json'] as $f) {
            copy("{$src}/modern-commerce/{$f}", "{$root}/modern-commerce/{$f}");
            copy("{$src}/modern-commerce/{$f}", "{$root}/second/{$f}");
        }
        copy("{$src}/fonts.json", "{$root}/fonts.json");
        $registry = json_decode(file_get_contents("{$src}/registry.json"), true);
        $registry[] = ['code' => 'second', 'name' => 'Second', 'description' => '', 'version' => '1.1.0', 'status' => 'available', 'tier' => 'free', 'price_amount' => null, 'currency' => null, 'tags' => [], 'is_new' => false];
        file_put_contents("{$root}/registry.json", json_encode($registry));
        $this->app->instance(ThemeRegistry::class, new ThemeRegistry($root));

        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $config = $this->defaultConfig();
        $config['settings']['primaryColor'] = '#123456';
        $config['settings']['cornerStyle'] = 'square';
        $this->saveDraft($headers, $store, $config, 1)->assertOk();
        $this->flushHeaders()->withHeaders($headers)->postJson($this->themeUrl($store, '/publish'), ['draft_revision' => 2])->assertOk();

        $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/themes/second/apply")
            ->assertOk()
            ->assertJsonPath('data.code', 'second')
            ->assertJsonPath('data.is_active', true)
            ->assertJsonPath('data.draft_revision', 1)
            ->assertJsonPath('data.published_config.settings.primaryColor', '#123456')
            ->assertJsonPath('data.published_config.settings.cornerStyle', 'square');

        $this->flushHeaders()->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/themes")
            ->assertJsonPath('data.0.code', 'second')
            ->assertJsonPath('data.1.is_active', false);
    }

    public function test_draft_validation_errors_use_dot_paths(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $config = $this->defaultConfig();
        $config['sections'][4]['settings']['limit'] = 99;
        $this->saveDraft($headers, $store, $config, 1)
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['config.sections.4.settings.limit']]]);

        $config = $this->defaultConfig();
        $config['theme'] = 'boutique';
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(422)->assertJsonPath('error.code', 'theme_mismatch');
        $config = $this->defaultConfig();
        $config['version'] = '2.0.0';
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(422)->assertJsonPath('error.code', 'theme_mismatch');

        $this->flushHeaders()->withHeaders($headers)->putJson($this->themeUrl($store, '/draft'), ['config' => $this->defaultConfig()])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['base_revision']]]);

        // Duplicate ids and maxInstances are semantic checks.
        $config = $this->defaultConfig();
        $config['sections'][1]['id'] = $config['sections'][0]['id'];
        $config['sections'][] = $config['sections'][0];
        $config['sections'][count($config['sections']) - 1]['id'] = 'h3ro0099';
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['config.sections.1.id', 'config.sections.10.type']]]);
    }

    public function test_empty_section_settings_round_trip_as_objects(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $config = $this->defaultConfig();
        $badges = array_search('trust-badges', array_column($config['sections'], 'type'), true);
        $raw = json_encode(['config' => $config, 'base_revision' => 1]);
        $raw = str_replace(json_encode($config['sections'][$badges]['settings']), '{}', $raw);

        $response = $this->flushHeaders()->withHeaders($headers + ['Content-Type' => 'application/json'])
            ->call('PUT', $this->themeUrl($store, '/draft'), [], [], [], $this->transformHeadersToServerVars($headers + ['CONTENT_TYPE' => 'application/json', 'Accept' => 'application/json']), $raw);
        $response->assertOk();
        $this->assertStringContainsString('"settings":{}', $response->getContent());
    }
}
