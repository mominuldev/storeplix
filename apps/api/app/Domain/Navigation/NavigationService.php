<?php

namespace App\Domain\Navigation;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Themes\SafeHref;
use App\Domain\Themes\ThemeConfigUpgrader;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

/** Navigation menus (PHASE-3-CONTRACT §3.3): defaults, validation, link resolution. */
class NavigationService
{
    public const MAX_ITEMS = 60;

    public const MAX_TOP_LEVEL = 20;

    public const MAX_CHILDREN = 20;

    public const ID_PATTERN = '/^[a-z0-9]{8,16}$/';

    public const BUILTINS = ['track_order' => '/track-order', 'cart' => '/cart', 'search' => '/search'];

    /** Default menu contents: page links by slug (skipped when the page doesn't exist). */
    private const DEFAULTS = [
        'main' => [['Home', 'home'], ['About us', 'about']],
        'footer' => [['Home', 'home']],
        'help' => [['Contact', 'contact'], ['Delivery & return policy', 'delivery-return'], ['Privacy policy', 'privacy'], ['Terms of service', 'terms']],
    ];

    /**
     * The three menus in order main, footer, help; missing rows are created with defaults.
     *
     * @return Collection<string, StoreNavigation>
     */
    public function menus(Store $store): Collection
    {
        $existing = StoreNavigation::query()->where('store_id', $store->id)->get()->keyBy('handle');

        if ($existing->count() < count(StoreNavigation::HANDLES)) {
            $pages = StorePage::query()->where('store_id', $store->id)->pluck('id', 'slug');
            foreach (StoreNavigation::HANDLES as $handle) {
                if (! $existing->has($handle)) {
                    $existing[$handle] = StoreNavigation::query()->firstOrCreate(
                        ['store_id' => $store->id, 'handle' => $handle],
                        ['title' => StoreNavigation::TITLES[$handle], 'items' => $this->defaultItems($handle, $pages->all())],
                    );
                }
            }
        }

        return collect(StoreNavigation::HANDLES)->mapWithKeys(fn ($h) => [$h => $existing[$h]]);
    }

    /**
     * Existing menu rows only (no lazy creation), for read paths like pages' in_menus.
     *
     * @return Collection<int, StoreNavigation>
     */
    public function existing(Store $store): Collection
    {
        return StoreNavigation::query()->where('store_id', $store->id)->get();
    }

    public function menu(Store $store, string $handle): StoreNavigation
    {
        if (! in_array($handle, StoreNavigation::HANDLES, true)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $this->menus($store)[$handle];
    }

    /**
     * @param  array<string, string>  $pageIdsBySlug
     * @return list<array<string, mixed>>
     */
    private function defaultItems(string $handle, array $pageIdsBySlug): array
    {
        $items = [];
        foreach (self::DEFAULTS[$handle] as [$label, $target]) {
            if ($target === 'home') {
                $items[] = ['id' => ThemeConfigUpgrader::randomId(), 'label' => $label, 'link' => ['type' => 'home']];
            } elseif (isset($pageIdsBySlug[$target])) {
                $items[] = ['id' => ThemeConfigUpgrader::randomId(), 'label' => $label, 'link' => ['type' => 'page', 'page_id' => $pageIdsBySlug[$target]]];
            }
        }

        return $items;
    }

    /**
     * Validates a whole menu (SaveNavigationInput.items). Resolved-only keys (href, link_status, page_title) are ignored.
     *
     * @return list<array<string, mixed>> normalised items
     *
     * @throws ValidationException
     */
    public function validateItems(Store $store, mixed $items): array
    {
        $errors = [];
        if (! is_array($items) || ! array_is_list($items)) {
            throw ValidationException::withMessages(['items' => ['Must be a list of links.']]);
        }
        if (count($items) > self::MAX_TOP_LEVEL) {
            throw ValidationException::withMessages(['items' => ['A menu can have at most '.self::MAX_TOP_LEVEL.' top-level links.']]);
        }

        $total = 0;
        $ids = [];
        $pageRefs = [];
        $out = [];
        foreach ($items as $i => $item) {
            $out[] = $this->item($item, "items.{$i}", 1, $errors, $ids, $pageRefs, $total);
        }

        if ($total > self::MAX_ITEMS) {
            $errors['items'][] = 'A menu can have at most '.self::MAX_ITEMS.' links.';
        }

        if ($pageRefs !== []) {
            $valid = StorePage::query()->where('store_id', $store->id)->whereIn('id', array_values($pageRefs))->pluck('id')->all();
            foreach ($pageRefs as $path => $id) {
                if (! in_array($id, $valid, true)) {
                    $errors[$path][] = 'Choose a page of this shop.';
                }
            }
        }

        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return $out;
    }

    /**
     * @param  array<string, list<string>>  $errors
     * @param  array<string, true>  $ids
     * @param  array<string, string>  $pageRefs
     * @return array<string, mixed>
     */
    private function item(mixed $item, string $path, int $depth, array &$errors, array &$ids, array &$pageRefs, int &$total): array
    {
        $total++;
        if (! is_array($item) || array_is_list($item)) {
            $errors[$path][] = 'Must be a link.';

            return [];
        }

        foreach (array_keys($item) as $key) {
            if (! in_array($key, ['id', 'label', 'link', 'children', 'href', 'link_status', 'page_title'], true)) {
                $errors["{$path}.{$key}"][] = 'Unknown field.';
            }
        }

        $id = $item['id'] ?? null;
        if (! is_string($id) || preg_match(self::ID_PATTERN, $id) !== 1) {
            $errors["{$path}.id"][] = 'Link id must be 8–16 lowercase letters or digits.';
        } elseif (isset($ids[$id])) {
            $errors["{$path}.id"][] = 'Link ids must be unique in the menu.';
        } else {
            $ids[$id] = true;
        }

        $label = is_string($item['label'] ?? null) ? trim($item['label']) : null;
        if ($label === null || $label === '' || mb_strlen($label) > 40 || preg_match('/[\x00-\x1F\x7F]/', $label) === 1) {
            $errors["{$path}.label"][] = 'The label must be 1–40 characters.';
        }

        $out = ['id' => $id, 'label' => $label, 'link' => $this->link($item['link'] ?? null, "{$path}.link", $errors, $pageRefs)];

        if (array_key_exists('children', $item) && $item['children'] !== null) {
            $children = $item['children'];
            if ($depth >= 2) {
                if ($children !== []) {
                    $errors["{$path}.children"][] = 'Menus can only be two levels deep.';
                }
            } elseif (! is_array($children) || ! array_is_list($children)) {
                $errors["{$path}.children"][] = 'Must be a list of links.';
            } elseif (count($children) > self::MAX_CHILDREN) {
                $errors["{$path}.children"][] = 'A link can have at most '.self::MAX_CHILDREN.' sub-links.';
            } else {
                $out['children'] = [];
                foreach ($children as $j => $child) {
                    $out['children'][] = $this->item($child, "{$path}.children.{$j}", $depth + 1, $errors, $ids, $pageRefs, $total);
                }
            }
        }

        return $out;
    }

    /**
     * @param  array<string, list<string>>  $errors
     * @param  array<string, string>  $pageRefs
     * @return array<string, mixed>|null
     */
    private function link(mixed $link, string $path, array &$errors, array &$pageRefs): ?array
    {
        $type = is_array($link) ? ($link['type'] ?? null) : null;
        $fields = ['home' => [], 'page' => ['page_id'], 'url' => ['url'], 'collection' => ['handle'], 'builtin' => ['target']];

        if (! is_string($type) || ! isset($fields[$type])) {
            $errors["{$path}.type"][] = 'Choose a link type.';

            return null;
        }
        foreach (array_keys($link) as $key) {
            if ($key !== 'type' && ! in_array($key, $fields[$type], true)) {
                $errors["{$path}.{$key}"][] = 'Unknown field.';
            }
        }

        switch ($type) {
            case 'page':
                $id = $link['page_id'] ?? null;
                if (! is_string($id) || preg_match('/^[0-9a-z]{26}$/i', $id) !== 1) {
                    $errors["{$path}.page_id"][] = 'Choose a page of this shop.';
                } else {
                    $pageRefs["{$path}.page_id"] = strtolower($id);

                    return ['type' => 'page', 'page_id' => strtolower($id)];
                }
                break;
            case 'url':
                $url = is_string($link['url'] ?? null) ? trim($link['url']) : null;
                if (! SafeHref::navUrl($url)) {
                    $errors["{$path}.url"][] = 'Enter a full web address starting with http:// or https://.';
                }

                return ['type' => 'url', 'url' => $url];
            case 'collection':
                $handle = $link['handle'] ?? null;
                if (! is_string($handle) || strlen($handle) > 80 || preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $handle) !== 1) {
                    $errors["{$path}.handle"][] = 'Enter a valid collection handle.';
                }

                return ['type' => 'collection', 'handle' => $handle];
            case 'builtin':
                if (! isset(self::BUILTINS[$link['target'] ?? ''])) {
                    $errors["{$path}.target"][] = 'Choose track_order, cart or search.';
                }

                return ['type' => 'builtin', 'target' => $link['target'] ?? null];
        }

        return ['type' => $type];
    }

    /**
     * NavItemResolved[] for the dashboard.
     *
     * @param  array<string, StorePage>  $pages  keyed by id
     * @return list<array<string, mixed>>
     */
    public function resolve(array $items, array $pages): array
    {
        return array_map(function (array $item) use ($pages) {
            [$href, $status, $title] = $this->target($item['link'] ?? [], $pages);
            $out = ['id' => $item['id'], 'label' => $item['label'], 'link' => $item['link'], 'href' => $href, 'link_status' => $status];
            if (($item['link']['type'] ?? null) === 'page') {
                $out['page_title'] = $title;
            }
            if (isset($item['children'])) {
                $out['children'] = $this->resolve($item['children'], $pages);
            }

            return $out;
        }, $items);
    }

    /**
     * StorefrontNavMenu items: public drops links whose status is not ok; preview keeps unpublished pages.
     * A parent whose own link is hidden keeps its remaining children and uses the first child's href.
     *
     * @param  array<string, StorePage>  $pages
     * @return list<array{id: string, label: string, href: string, children: list<mixed>}>
     */
    public function storefront(array $items, array $pages, bool $preview): array
    {
        $out = [];
        foreach ($items as $item) {
            [$href, $status] = $this->target($item['link'] ?? [], $pages);
            $visible = $href !== null && ($status === 'ok' || ($preview && $status === 'page_unpublished'));
            $children = isset($item['children']) ? $this->storefront($item['children'], $pages, $preview) : [];

            if (! $visible) {
                if ($children === []) {
                    continue;
                }
                $href = $children[0]['href'];
            }

            $out[] = ['id' => $item['id'], 'label' => $item['label'], 'href' => $href, 'children' => $children];
        }

        return $out;
    }

    /**
     * @param  array<string, StorePage>  $pages
     * @return array{0: string|null, 1: string, 2: string|null} [href, link_status, page_title]
     */
    private function target(array $link, array $pages): array
    {
        return match ($link['type'] ?? null) {
            'home' => ['/', 'ok', null],
            'page' => isset($pages[$link['page_id'] ?? ''])
                ? ['/pages/'.$pages[$link['page_id']]->slug, $pages[$link['page_id']]->isPublished() ? 'ok' : 'page_unpublished', $pages[$link['page_id']]->title]
                : [null, 'page_missing', null],
            'url' => [SafeHref::navUrl($link['url'] ?? null) ? $link['url'] : null, 'ok', null],
            'collection' => ['/collections/'.($link['handle'] ?? ''), 'ok', null],
            'builtin' => [self::BUILTINS[$link['target'] ?? ''] ?? null, 'ok', null],
            default => [null, 'page_missing', null],
        };
    }

    /**
     * Handles of menus that link to a page (anywhere in the tree).
     *
     * @param  Collection<string, StoreNavigation>|iterable<StoreNavigation>  $menus
     * @return list<string>
     */
    public static function menusContaining(string $pageId, iterable $menus): array
    {
        $handles = [];
        foreach ($menus as $menu) {
            if (self::contains($menu->items ?? [], $pageId)) {
                $handles[] = $menu->handle;
            }
        }

        return $handles;
    }

    private static function contains(array $items, string $pageId): bool
    {
        foreach ($items as $item) {
            if ((($item['link']['type'] ?? null) === 'page' && ($item['link']['page_id'] ?? null) === $pageId)
                || self::contains($item['children'] ?? [], $pageId)) {
                return true;
            }
        }

        return false;
    }

    /** Appends a page link to a menu (add_to_menu, "Show in menu"). Caller wraps in a transaction. */
    public function appendPage(Store $store, string $handle, StorePage $page, ?string $userId): StoreNavigation
    {
        $menu = $this->menu($store, $handle);
        $items = $menu->items ?? [];

        if (count($items) >= self::MAX_TOP_LEVEL || $this->count($items) >= self::MAX_ITEMS) {
            throw ValidationException::withMessages(['add_to_menu' => ['This menu is full.']]);
        }

        $items[] = ['id' => ThemeConfigUpgrader::randomId(), 'label' => mb_substr($page->title, 0, 40), 'link' => ['type' => 'page', 'page_id' => $page->id]];
        $menu->items = $items;
        $menu->revision++;
        $menu->updated_by = $userId;
        $menu->save();

        return $menu;
    }

    private function count(array $items): int
    {
        return array_sum(array_map(fn ($i) => 1 + $this->count($i['children'] ?? []), $items));
    }
}
