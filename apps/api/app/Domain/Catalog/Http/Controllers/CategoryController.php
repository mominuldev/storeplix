<?php

namespace App\Domain\Catalog\Http\Controllers;

use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Http\Requests\CategoryRequest;
use App\Domain\Catalog\Http\Resources\CategoryPresenter;
use App\Domain\Catalog\Models\Category;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

/** §3.1 categories. */
class CategoryController
{
    public function __construct(private readonly CategoryService $categories) {}

    /** GET /stores/{store}/categories?q= — flat depth-first list, max 500. */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['q' => ['sometimes', 'nullable', 'string', 'max:80']]);
        $q = mb_strtolower(trim((string) ($input['q'] ?? '')));

        $tree = $this->categories->tree($store);
        $list = $q === '' ? $tree : $tree->filter(fn (Category $c) => str_contains(mb_strtolower($c->name), $q))->values();

        return new JsonResponse([
            'data' => $this->present($store, $list->all(), $tree->all()),
            'meta' => ['count' => $list->count(), 'limit' => Category::MAX_PER_STORE],
        ]);
    }

    public function store(CategoryRequest $request, Store $store): JsonResponse
    {
        $category = $this->categories->create($store, $request->validated(), $request->user());

        return $this->one($store, $category, 201);
    }

    public function show(Store $store, Category $category): JsonResponse
    {
        Gate::authorize('view', $category);

        return $this->one($store, $category);
    }

    public function update(CategoryRequest $request, Store $store, Category $category): JsonResponse
    {
        Gate::authorize('update', $category);

        return $this->one($store, $this->categories->update($store, $category, $request->validated(), $request->user()));
    }

    /** PUT /stores/{store}/categories/order */
    public function reorder(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'items' => ['required', 'array', 'max:'.Category::MAX_PER_STORE],
            'items.*' => ['array:id,parent_id'],
            'items.*.id' => ['required', 'string', 'size:26'],
            'items.*.parent_id' => ['present', 'nullable', 'string', 'size:26'],
        ]);

        $tree = $this->categories->reorder($store, array_values($input['items']), $request->user());

        return new JsonResponse(['data' => $this->present($store, $tree->all(), $tree->all())]);
    }

    public function destroy(Store $store, Category $category): Response
    {
        Gate::authorize('delete', $category);
        $this->categories->delete($category);

        return response()->noContent();
    }

    private function one(Store $store, Category $category, int $status = 200): JsonResponse
    {
        $category->refresh()->load('image');
        $children = Category::query()->where('parent_id', $category->id)->count();
        $products = $this->categories->productCounts($store)[$category->id] ?? 0;

        return new JsonResponse(['data' => CategoryPresenter::category($category, $products, $children)], $status);
    }

    /**
     * @param  list<Category>  $list
     * @param  list<Category>  $all
     * @return list<array<string, mixed>>
     */
    private function present(Store $store, array $list, array $all): array
    {
        $counts = $this->categories->productCounts($store);
        $children = [];
        foreach ($all as $c) {
            if ($c->parent_id !== null) {
                $children[$c->parent_id] = ($children[$c->parent_id] ?? 0) + 1;
            }
        }

        return array_map(fn (Category $c) => CategoryPresenter::category($c, $counts[$c->id] ?? 0, $children[$c->id] ?? 0), $list);
    }
}
