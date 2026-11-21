<?php

namespace App\Domain\Stores\Services;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Pages\PageService;
use App\Domain\Stores\Models\Store;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Support\Facades\DB;

/**
 * Default content for a store (P3-13): active theme, default pages and the three menus. Idempotent:
 * the theme is ensured every time; pages and menus are seeded together only while the store has no menus
 * yet, so pages a merchant deletes later never come back.
 */
class StoreContentProvisioner
{
    /** [template, status] — About + Contact published; legal pages stay drafts until reviewed (Q17). */
    public const DEFAULT_PAGES = [
        ['about', StorePage::PUBLISHED],
        ['contact', StorePage::PUBLISHED],
        ['privacy', StorePage::DRAFT],
        ['terms', StorePage::DRAFT],
        ['returns', StorePage::DRAFT],
    ];

    public function __construct(
        private readonly StoreThemeService $themes,
        private readonly PageService $pages,
        private readonly NavigationService $navigation,
    ) {}

    /** Must run inside the store's tenant context. Returns what was created. */
    public function ensure(Store $store): array
    {
        return DB::transaction(function () use ($store) {
            $created = ['theme' => false, 'pages' => 0, 'menus' => 0];

            if (! $store->themes()->where('is_active', true)->exists()) {
                $this->themes->active($store);
                $created['theme'] = true;
            }

            if (StoreNavigation::query()->where('store_id', $store->id)->exists()) {
                return $created;
            }

            $existing = StorePage::query()->where('store_id', $store->id)->pluck('template')->all();
            foreach (self::DEFAULT_PAGES as [$template, $status]) {
                if (in_array($template, $existing, true)) {
                    continue;
                }
                $this->pages->create($store, ['template' => $template, 'status' => $status], null, audit: false);
                $created['pages']++;
            }

            $created['menus'] = $this->navigation->menus($store)->count();

            return $created;
        });
    }
}
