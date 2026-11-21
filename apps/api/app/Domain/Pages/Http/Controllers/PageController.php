<?php

namespace App\Domain\Pages\Http\Controllers;

use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Http\Requests\PageRequest;
use App\Domain\Pages\Http\Resources\StorePagePresenter;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Pages\PageService;
use App\Domain\Pages\PageTemplates;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

class PageController
{
    public function __construct(
        private readonly PageService $pages,
        private readonly NavigationService $navigation,
    ) {}

    /** GET /page-templates */
    public function templates(PageTemplates $templates): JsonResponse
    {
        return new JsonResponse(['data' => $templates->all()]);
    }

    /** GET /stores/{store}/pages?filter[status]=…&q=… */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status'],
            'filter.status' => ['sometimes', 'string', 'regex:/^(draft|published|hidden)(,(draft|published|hidden))*$/'],
            'q' => ['sometimes', 'nullable', 'string', 'max:80'],
        ]);

        $all = StorePage::query()->where('store_id', $store->id)->with('updatedBy')
            ->orderByDesc('updated_at')->orderByDesc('id')->get();

        $statuses = isset($input['filter']['status']) ? explode(',', $input['filter']['status']) : null;
        $q = isset($input['q']) ? mb_strtolower(trim($input['q'])) : '';
        $filtered = $all->filter(fn (StorePage $p) => ($statuses === null || in_array($p->status, $statuses, true))
            && ($q === '' || str_contains(mb_strtolower($p->title), $q) || str_contains($p->slug, $q)));

        $menus = $this->navigation->existing($store);
        $counts = ['all' => $all->count()];
        foreach (StorePage::STATUSES as $status) {
            $counts[$status] = $all->where('status', $status)->count();
        }

        return new JsonResponse([
            'data' => $filtered->values()->map(fn ($p) => StorePagePresenter::summary($p, $menus))->all(),
            'meta' => ['counts' => $counts, 'limit' => StorePage::MAX_PER_STORE],
        ]);
    }

    public function store(PageRequest $request, Store $store): JsonResponse
    {
        $page = $this->pages->create($store, $request->pageInput(), $request->user());

        return $this->ok($store, $page, 201);
    }

    public function show(Store $store, StorePage $page): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->ok($store, $page);
    }

    public function update(PageRequest $request, Store $store, StorePage $page): JsonResponse
    {
        return $this->ok($store, $this->pages->update($store, $page, $request->pageInput(), $request->user()));
    }

    public function destroy(Store $store, StorePage $page): Response
    {
        Gate::authorize('update', $store);
        $this->pages->delete($page);

        return response()->noContent();
    }

    private function ok(Store $store, StorePage $page, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => StorePagePresenter::full($page->refresh(), $this->navigation->existing($store))], $status);
    }
}
