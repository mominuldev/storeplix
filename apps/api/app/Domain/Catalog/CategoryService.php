<?php

namespace App\Domain\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\ProductCategory;
use App\Domain\Catalog\Support\Slug;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/** Category tree rules (P4-8, §3.1). Revalidation: StorefrontRevalidationObserver. */
class CategoryService
{
    public const DEPTH_MESSAGE = 'Categories can only be three levels deep.';

    public function __construct(private readonly AuditLogger $audit) {}

    /** @return Collection<int, Category> every non-deleted category of the store, depth-first tree order */
    public function tree(Store $store): Collection
    {
        $all = Category::query()->where('store_id', $store->id)->with('image')
            ->orderBy('position')->orderBy('id')->get();

        return new Collection(self::depthFirst($all->all()));
    }

    /**
     * @param  list<Category>  $categories
     * @return list<Category>
     */
    public static function depthFirst(array $categories): array
    {
        $byParent = [];
        foreach ($categories as $c) {
            $byParent[$c->parent_id ?? ''][] = $c;
        }
        $out = [];
        $walk = function (string $parent) use (&$walk, &$out, $byParent): void {
            foreach ($byParent[$parent] ?? [] as $c) {
                $out[] = $c;
                $walk($c->id);
            }
        };
        $walk('');

        return $out;
    }

    /** @return array<string, int> category id → number of non-deleted products */
    public function productCounts(Store $store): array
    {
        return ProductCategory::query()
            ->join('products', 'products.id', '=', 'product_categories.product_id')
            ->where('product_categories.store_id', $store->id)
            ->whereNull('products.deleted_at')
            ->groupBy('product_categories.category_id')
            ->selectRaw('product_categories.category_id as category_id, count(*) as aggregate')
            ->pluck('aggregate', 'category_id')->map(fn ($n) => (int) $n)->all();
    }

    /**
     * @param  array<string, mixed>  $input  validated CreateCategoryInput
     */
    public function create(Store $store, array $input, ?User $user): Category
    {
        return DB::transaction(function () use ($store, $input, $user) {
            if (Category::query()->where('store_id', $store->id)->count() >= Category::MAX_PER_STORE) {
                throw new ApiException(409, 'category_limit_reached', 'A shop can have at most '.Category::MAX_PER_STORE.' categories.');
            }

            $parent = $this->parent($store, $input['parent_id'] ?? null);
            $depth = $parent ? $parent->depth + 1 : 1;
            if ($depth > Category::MAX_DEPTH) {
                throw ValidationException::withMessages(['parent_id' => [self::DEPTH_MESSAGE]]);
            }

            $slug = $input['slug'] ?? null;
            if ($slug !== null) {
                $this->assertSlugFree($store, $slug);
            } else {
                $slug = Slug::unique(Slug::from($input['name'], 'c', 140), 140, fn ($s) => $this->slugTaken($store, $s));
            }

            $category = new Category([
                'parent_id' => $parent?->id,
                'name' => $input['name'],
                'slug' => $slug,
                'description' => $input['description'] ?? null,
                'image_media_id' => $input['image_media_id'] ?? null,
                'depth' => $depth,
                'position' => $this->nextPosition($store, $parent?->id),
                'is_visible' => $input['is_visible'] ?? true,
                'created_by' => $user?->getKey(),
                'updated_by' => $user?->getKey(),
            ]);
            $category->store_id = $store->id;
            $category->save();

            return $category;
        });
    }

    /**
     * @param  array<string, mixed>  $input  validated UpdateCategoryInput (partial)
     */
    public function update(Store $store, Category $category, array $input, ?User $user): Category
    {
        return DB::transaction(function () use ($store, $category, $input, $user) {
            $category = Category::query()->whereKey($category->id)->lockForUpdate()->firstOrFail();

            foreach (['name', 'description', 'image_media_id', 'is_visible'] as $key) {
                if (array_key_exists($key, $input)) {
                    $category->{$key} = $input[$key];
                }
            }
            if (array_key_exists('slug', $input) && $input['slug'] !== null && $input['slug'] !== $category->slug) {
                $this->assertSlugFree($store, $input['slug'], $category->id);
                $category->slug = $input['slug'];
            }

            $moved = false;
            if (array_key_exists('parent_id', $input) && $input['parent_id'] !== $category->parent_id) {
                $all = Category::query()->where('store_id', $store->id)->get()->keyBy('id');
                $parent = $input['parent_id'] === null ? null : ($all[$input['parent_id']] ?? null);
                if ($input['parent_id'] !== null && $parent === null) {
                    throw ValidationException::withMessages(['parent_id' => ['Unknown category.']]);
                }
                if ($parent !== null && ($parent->id === $category->id || $this->isDescendant($all->all(), $parent->id, $category->id))) {
                    throw ValidationException::withMessages(['parent_id' => ["A category can't be moved inside itself."]]);
                }
                $newDepth = $parent ? $parent->depth + 1 : 1;
                if ($newDepth + $this->height($all->all(), $category->id) - 1 > Category::MAX_DEPTH) {
                    throw ValidationException::withMessages(['parent_id' => [self::DEPTH_MESSAGE]]);
                }
                $category->parent_id = $parent?->id;
                $category->position = $this->nextPosition($store, $parent?->id);
                $category->depth = $newDepth;
                $moved = true;
            }

            $category->updated_by = $user?->getKey();
            $category->save();

            if ($moved) {
                $this->recomputeDepths($store);
            }

            return $category;
        });
    }

    /**
     * Rewrites parent_id / depth / position of EVERY category (the list must be the full set).
     *
     * @param  list<array{id: string, parent_id: string|null}>  $items
     * @return Collection<int, Category>
     */
    public function reorder(Store $store, array $items, ?User $user): Collection
    {
        return DB::transaction(function () use ($store, $items, $user) {
            $all = Category::query()->where('store_id', $store->id)->lockForUpdate()->get()->keyBy('id');
            $ids = array_column($items, 'id');
            $stale = ['items' => ['The list is out of date. Reload and try again.']];

            if (count($ids) !== count(array_unique($ids)) || count($ids) !== $all->count() || array_diff($ids, $all->keys()->all()) !== []) {
                throw ValidationException::withMessages($stale);
            }

            $parents = [];
            foreach ($items as $i => $item) {
                $parentId = $item['parent_id'] ?? null;
                if ($parentId !== null && ! isset($all[$parentId])) {
                    throw ValidationException::withMessages(["items.{$i}.parent_id" => ['Unknown category.']]);
                }
                if ($parentId === $item['id']) {
                    throw ValidationException::withMessages(["items.{$i}.parent_id" => ["A category can't be moved inside itself."]]);
                }
                $parents[$item['id']] = $parentId;
            }

            // Depth via parent chain; a chain longer than the set is a cycle.
            $depths = [];
            foreach ($items as $i => $item) {
                $depth = 1;
                $cursor = $parents[$item['id']];
                while ($cursor !== null) {
                    $depth++;
                    if ($depth > count($items) + 1) {
                        throw ValidationException::withMessages(["items.{$i}.parent_id" => ["A category can't be moved inside itself."]]);
                    }
                    $cursor = $parents[$cursor];
                }
                if ($depth > Category::MAX_DEPTH) {
                    throw ValidationException::withMessages(["items.{$i}.parent_id" => [self::DEPTH_MESSAGE]]);
                }
                $depths[$item['id']] = $depth;
            }

            $positions = [];
            foreach ($items as $item) {
                $key = $parents[$item['id']] ?? '';
                $positions[$key] = ($positions[$key] ?? -1) + 1;
                $category = $all[$item['id']];
                // Parents first in the list order is not guaranteed; FK checks are immediate, but every referenced
                // parent already exists, so any order is valid.
                $category->parent_id = $parents[$item['id']];
                $category->depth = $depths[$item['id']];
                $category->position = $positions[$key];
                if ($category->isDirty()) {
                    $category->updated_by = $user?->getKey();
                    $category->save();
                }
            }

            return $this->tree($store);
        });
    }

    public function delete(Category $category): void
    {
        DB::transaction(function () use ($category) {
            $category = Category::query()->whereKey($category->id)->lockForUpdate()->firstOrFail();
            if (Category::query()->where('parent_id', $category->id)->exists()) {
                throw new ApiException(409, 'category_has_children', 'Move or delete its sub-categories first.');
            }
            ProductCategory::query()->where('category_id', $category->id)->delete();
            $category->delete();
            $this->audit->log('category.deleted', $category, ['name' => $category->name, 'slug' => $category->slug]);
        });
    }

    /** @return list<string> the category ids plus all their descendants (non-deleted) */
    public function withDescendants(Store $store, array $ids): array
    {
        $all = Category::query()->where('store_id', $store->id)->get(['id', 'parent_id']);
        $children = [];
        foreach ($all as $c) {
            $children[$c->parent_id ?? ''][] = $c->id;
        }
        $out = [];
        $stack = $ids;
        while ($stack !== []) {
            $id = array_pop($stack);
            if (isset($out[$id])) {
                continue;
            }
            $out[$id] = true;
            foreach ($children[$id] ?? [] as $child) {
                $stack[] = $child;
            }
        }

        return array_keys($out);
    }

    private function parent(Store $store, ?string $parentId): ?Category
    {
        if ($parentId === null) {
            return null;
        }

        return Category::query()->where('store_id', $store->id)->whereKey($parentId)->first()
            ?? throw ValidationException::withMessages(['parent_id' => ['Unknown category.']]);
    }

    public function nextPosition(Store $store, ?string $parentId): int
    {
        $max = Category::query()->where('store_id', $store->id)
            ->when($parentId === null, fn ($q) => $q->whereNull('parent_id'), fn ($q) => $q->where('parent_id', $parentId))
            ->max('position');

        return $max === null ? 0 : ((int) $max) + 1;
    }

    public function slugTaken(Store $store, string $slug, ?string $exceptId = null): bool
    {
        return Category::query()->where('store_id', $store->id)->where('slug', $slug)
            ->when($exceptId, fn ($q) => $q->whereKeyNot($exceptId))->exists();
    }

    private function assertSlugFree(Store $store, string $slug, ?string $exceptId = null): void
    {
        if ($this->slugTaken($store, $slug, $exceptId)) {
            throw ValidationException::withMessages(['slug' => ['This link is already used by another category.']]);
        }
    }

    /** @param array<string, Category> $all */
    private function isDescendant(array $all, string $candidate, string $ancestor): bool
    {
        $cursor = $all[$candidate]->parent_id ?? null;
        for ($i = 0; $cursor !== null && $i < 10; $i++) {
            if ($cursor === $ancestor) {
                return true;
            }
            $cursor = $all[$cursor]->parent_id ?? null;
        }

        return false;
    }

    /** Height of the subtree rooted at $id (a leaf = 1). @param array<string, Category> $all */
    private function height(array $all, string $id): int
    {
        $max = 0;
        foreach ($all as $c) {
            if ($c->parent_id === $id) {
                $max = max($max, $this->height($all, $c->id));
            }
        }

        return $max + 1;
    }

    private function recomputeDepths(Store $store): void
    {
        $all = Category::query()->where('store_id', $store->id)->get()->keyBy('id');
        foreach (self::depthFirst($all->all()) as $c) {
            $depth = $c->parent_id ? $all[$c->parent_id]->depth + 1 : 1;
            if ($c->depth !== $depth) {
                $c->depth = $depth;
                $c->save();
            }
        }
    }
}
