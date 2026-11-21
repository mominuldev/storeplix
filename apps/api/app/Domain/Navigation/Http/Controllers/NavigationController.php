<?php

namespace App\Domain\Navigation\Http\Controllers;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class NavigationController
{
    public function __construct(private readonly NavigationService $navigation) {}

    /** GET /stores/{store}/navigation → NavigationMenu[] (main, footer, help). */
    public function index(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $menus = $this->navigation->menus($store);
        $pages = $this->pages($store);

        return new JsonResponse(['data' => $menus->values()->map(fn ($m) => $this->present($m, $pages))->all()]);
    }

    /** PUT /stores/{store}/navigation/{handle} — whole menu, optimistic revision. */
    public function update(Request $request, Store $store, string $handle, AuditLogger $audit): JsonResponse
    {
        Gate::authorize('update', $store);
        $menu = $this->navigation->menu($store, $handle);

        $input = $request->validate([
            'title' => ['sometimes', 'string', 'min:1', 'max:40', 'regex:/^[^\x00-\x1F\x7F]*$/'],
            'items' => ['present', 'array'],
            'revision' => ['required', 'integer'],
        ]);
        $items = $this->navigation->validateItems($store, $request->input('items'));

        $menu = DB::transaction(function () use ($menu, $input, $items, $request) {
            $updated = StoreNavigation::query()->whereKey($menu->id)->where('revision', (int) $input['revision'])->update([
                'title' => isset($input['title']) ? trim($input['title']) : $menu->title,
                'items' => json_encode($items, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                'revision' => DB::raw('revision + 1'),
                'updated_by' => $request->user()?->getKey(),
                'updated_at' => now(),
            ]);
            if ($updated === 0) {
                throw StoreThemeService::conflict();
            }

            $menu = $menu->refresh();
            $menu->touch(); // fires saved → storefront revalidation

            return $menu;
        });

        $audit->log('navigation.updated', $menu, ['handle' => $menu->handle]);

        return new JsonResponse(['data' => $this->present($menu, $this->pages($store))]);
    }

    /** @return array<string, StorePage> */
    private function pages(Store $store): array
    {
        return StorePage::query()->where('store_id', $store->id)->get(['id', 'slug', 'title', 'status'])->keyBy('id')->all();
    }

    /**
     * @param  array<string, StorePage>  $pages
     * @return array<string, mixed>
     */
    private function present(StoreNavigation $menu, array $pages): array
    {
        return [
            'id' => $menu->id,
            'handle' => $menu->handle,
            'title' => $menu->title,
            'items' => $this->navigation->resolve($menu->items ?? [], $pages),
            'revision' => $menu->revision,
            'updated_at' => $menu->updated_at?->toIso8601ZuluString(),
        ];
    }
}
