<?php

namespace App\Domain\Themes;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Support\Facades\DB;

/**
 * Draft/publish lifecycle of store themes (PHASE-3-CONTRACT §3.1). Revalidation is done by the
 * StorefrontRevalidationObserver when published_config / is_active change; draft saves never revalidate.
 */
class StoreThemeService
{
    /** Brand keys carried over when applying another theme. */
    public const CARRY_OVER = ['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'fontFamily', 'headingFontFamily', 'cornerStyle'];

    public function __construct(
        private readonly ThemeRegistry $registry,
        private readonly AuditLogger $audit,
    ) {}

    /** The active theme; installs the default theme (published) when a store has none. */
    public function active(Store $store): StoreTheme
    {
        $active = StoreTheme::query()->where('store_id', $store->id)->where('is_active', true)->first();
        if ($active !== null) {
            return $active;
        }

        return DB::transaction(function () use ($store) {
            $code = $this->registry->defaultCode();
            $theme = StoreTheme::query()->where('store_id', $store->id)->where('theme_code', $code)->first()
                ?? $this->newTheme($store, $code, $this->registry->defaults($code));
            $theme->published_config ??= $theme->draft_config;
            $theme->published_revision ??= $theme->draft_revision;
            $theme->published_at ??= now();
            $theme->is_active = true;
            $theme->save();

            return $theme;
        });
    }

    /**
     * @param  array<string, mixed>  $config  validated + normalised
     */
    public function saveDraft(StoreTheme $theme, array $config, int $baseRevision, ?User $user): StoreTheme
    {
        $json = json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

        $updated = StoreTheme::query()
            ->whereKey($theme->id)
            ->where('draft_revision', $baseRevision)
            ->update([
                'draft_config' => $json,
                'theme_version' => (string) $config['version'],
                'draft_revision' => DB::raw('draft_revision + 1'),
                'draft_updated_at' => now(),
                'draft_updated_by' => $user?->getKey(),
                'updated_at' => now(),
            ]);

        if ($updated === 0) {
            throw self::conflict();
        }

        return $theme->refresh();
    }

    public function publish(StoreTheme $theme, int $draftRevision, ?User $user): StoreTheme
    {
        if (! $theme->is_active) {
            throw new ApiException(409, 'theme_not_active', 'Only the active theme can be published.');
        }

        return DB::transaction(function () use ($theme, $draftRevision, $user) {
            $locked = StoreTheme::query()->whereKey($theme->id)->lockForUpdate()->firstOrFail();
            if ($locked->draft_revision !== $draftRevision) {
                throw self::conflict();
            }

            $locked->fill([
                'published_config' => $locked->draft_config,
                'published_revision' => $locked->draft_revision,
                'published_at' => now(),
                'published_by' => $user?->getKey(),
            ])->save();

            $this->audit->log('theme.published', $locked, ['code' => $locked->theme_code, 'revision' => $locked->draft_revision]);

            return $locked;
        });
    }

    public function discard(StoreTheme $theme): StoreTheme
    {
        return DB::transaction(function () use ($theme) {
            $locked = StoreTheme::query()->whereKey($theme->id)->lockForUpdate()->firstOrFail();
            if ($locked->published_config === null) {
                throw new ApiException(409, 'nothing_published', 'This theme has never been published.');
            }

            $locked->draft_config = $locked->published_config;
            $locked->theme_version = (string) ($locked->published_config['version'] ?? $locked->theme_version);
            $locked->draft_revision++;
            $locked->draft_updated_at = now();
            $locked->save();

            $this->audit->log('theme.discarded', $locked, ['code' => $locked->theme_code]);

            return $locked;
        });
    }

    public function apply(Store $store, string $code, ?User $user): StoreTheme
    {
        if ($this->registry->find($code) === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if (! $this->registry->isAvailable($code)) {
            throw new ApiException(409, 'theme_unavailable', 'This theme is not available yet.');
        }

        return DB::transaction(function () use ($store, $code, $user) {
            $current = StoreTheme::query()->where('store_id', $store->id)->where('is_active', true)->lockForUpdate()->first();
            $theme = $current?->theme_code === $code
                ? $current
                : StoreTheme::query()->where('store_id', $store->id)->where('theme_code', $code)->lockForUpdate()->first();

            if ($theme === null) {
                $config = $this->registry->defaults($code);
                $source = $current?->published_config ?? $current?->draft_config;
                foreach (self::CARRY_OVER as $key) {
                    if (isset($source['settings'][$key]) && array_key_exists($key, $config['settings'])) {
                        $config['settings'][$key] = $source['settings'][$key];
                    }
                }
                $theme = $this->newTheme($store, $code, $config, $user);
            }

            if ($current !== null && $current->id !== $theme->id) {
                $current->is_active = false;
                $current->save(); // before activating the new row (partial unique index)
            }

            if ($theme->published_config === null) {
                $theme->published_config = $theme->draft_config;
                $theme->published_revision = $theme->draft_revision;
                $theme->published_at = now();
                $theme->published_by = $user?->getKey();
            }
            $theme->is_active = true;
            $theme->applied_at = now();
            $theme->save();

            $this->audit->log('theme.applied', $theme, ['code' => $code]);

            return $theme;
        });
    }

    /**
     * P3-8: Phase 2 colour shortcut writes the active theme's draft AND published colours.
     *
     * @param  array<string, string>  $colors  e.g. ['primaryColor' => '#aabbcc']
     * @return list<string> changed theme keys
     */
    public function setBrandColors(Store $store, array $colors): array
    {
        if ($colors === []) {
            return [];
        }
        $theme = $this->active($store);
        $draft = $theme->draft_config;
        $published = $theme->published_config ?? $draft;
        $changed = [];

        foreach ($colors as $key => $value) {
            if (($published['settings'][$key] ?? null) !== $value || ($draft['settings'][$key] ?? null) !== $value) {
                $changed[] = $key;
            }
            $draft['settings'][$key] = $value;
            $published['settings'][$key] = $value;
        }

        if ($changed !== []) {
            $theme->draft_config = $draft;
            $theme->published_config = $published;
            $theme->draft_revision++;
            $theme->draft_updated_at = now();
            $theme->published_at ??= now();
            $theme->published_revision = $theme->draft_config == $theme->published_config ? $theme->draft_revision : $theme->published_revision;
            $theme->save();
        }

        return $changed;
    }

    /**
     * @param  array<string, mixed>  $config
     */
    private function newTheme(Store $store, string $code, array $config, ?User $user = null): StoreTheme
    {
        return StoreTheme::query()->create([
            'store_id' => $store->id,
            'theme_code' => $code,
            'theme_version' => (string) ($config['version'] ?? $this->registry->version($code)),
            'draft_config' => $config,
            'draft_revision' => 1,
            'draft_updated_at' => now(),
            'draft_updated_by' => $user?->getKey(),
            'is_active' => false,
        ]);
    }

    public static function conflict(): ApiException
    {
        return new ApiException(409, 'revision_conflict', 'Changed in another tab or by a teammate. Reload to continue.');
    }
}
