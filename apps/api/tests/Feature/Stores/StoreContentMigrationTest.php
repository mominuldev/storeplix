<?php

namespace Tests\Feature\Stores;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/** P3-13 / P3-14: theme backfill from store_settings.theme and idempotent stores:ensure-content. */
class StoreContentMigrationTest extends TestCase
{
    use DatabaseMigrations;

    public function test_migration_moves_theme_into_store_themes_and_ensure_content_is_idempotent(): void
    {
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'legacy');

        // Back to the Phase 2 schema with a legacy store that has a stored 1.0 theme and no Phase 3 content.
        // Roll back the two Phase 3 migrations and everything after them (Phase 4+).
        $steps = count(array_filter(scandir(database_path('migrations')), fn ($f) => strcmp($f, '2026_03_01_000100') >= 0 && str_ends_with($f, '.php')));
        $this->artisan('migrate:rollback', ['--step' => $steps])->assertSuccessful();
        $this->assertTrue(Schema::hasColumn('store_settings', 'theme'));
        $this->assertFalse(Schema::hasTable('store_pages'));
        DB::table('store_settings')->where('store_id', $store->id)->update(['theme' => json_encode([
            'theme' => 'modern-commerce', 'version' => '1.0.0',
            'settings' => ['primaryColor' => '#123ABC', 'secondaryColor' => '#0d0d18', 'fontFamily' => 'Inter'],
            'sections' => [['type' => 'hero', 'enabled' => true, 'settings' => ['heading' => 'Legacy hero']]],
        ])]);

        $this->artisan('migrate')->assertSuccessful();

        $this->assertFalse(Schema::hasColumn('store_settings', 'theme'));
        $theme = StoreTheme::withoutTenancy()->where('store_id', $store->id)->sole();
        $this->assertTrue($theme->is_active);
        $this->assertSame('1.1.0', $theme->theme_version);
        $this->assertSame($theme->draft_config, $theme->published_config);
        $this->assertSame(1, $theme->published_revision);
        $this->assertSame('#123abc', $theme->published_config['settings']['primaryColor']);
        $this->assertSame('Legacy hero', $theme->published_config['sections'][0]['settings']['heading']);
        $this->assertMatchesRegularExpression('/^[a-z0-9]{8,16}$/', $theme->published_config['sections'][0]['id']);

        $this->artisan('stores:ensure-content')->assertSuccessful();
        $snapshot = fn () => [
            StoreTheme::withoutTenancy()->orderBy('id')->get(['id', 'draft_revision'])->toArray(),
            StorePage::withoutTenancy()->orderBy('slug')->get(['id', 'slug', 'status'])->toArray(),
            StoreNavigation::withoutTenancy()->orderBy('handle')->get(['id', 'handle', 'revision', 'items'])->toArray(),
        ];
        $first = $snapshot();
        $this->assertSame(['about', 'contact', 'delivery-return', 'privacy', 'terms'], array_column($first[1], 'slug'));
        $this->assertSame(['published', 'published', 'draft', 'draft', 'draft'], array_column($first[1], 'status'));
        $this->assertSame(['footer', 'help', 'main'], array_column($first[2], 'handle'));

        $this->artisan('stores:ensure-content')->assertSuccessful();
        $this->assertSame($first, $snapshot());

        // A page the merchant deletes later is not recreated on the next deploy.
        StorePage::withoutTenancy()->where('slug', 'terms')->delete();
        $this->artisan('stores:ensure-content')->assertSuccessful();
        $this->assertFalse(StorePage::withoutTenancy()->where('slug', 'terms')->exists());

        // down() restores the column from the published config.
        // Roll back the two Phase 3 migrations and everything after them (Phase 4+).
        $steps = count(array_filter(scandir(database_path('migrations')), fn ($f) => strcmp($f, '2026_03_01_000100') >= 0 && str_ends_with($f, '.php')));
        $this->artisan('migrate:rollback', ['--step' => $steps])->assertSuccessful();
        $restored = json_decode(DB::table('store_settings')->where('store_id', $store->id)->value('theme'), true);
        $this->assertSame('1.1.0', $restored['version']);
    }
}
