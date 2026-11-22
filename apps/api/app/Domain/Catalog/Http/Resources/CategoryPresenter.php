<?php

namespace App\Domain\Catalog\Http\Resources;

use App\Domain\Catalog\Models\Category;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Shared\Http\UserRef;

/** Category / CategoryRef payloads (@storeplix/types). */
final class CategoryPresenter
{
    /** @return array<string, mixed> */
    public static function category(Category $category, int $productCount, int $childrenCount): array
    {
        return [
            'id' => $category->id,
            'parent_id' => $category->parent_id,
            'name' => $category->name,
            'slug' => $category->slug,
            'description' => $category->description,
            'image' => MediaPresenter::ref($category->image),
            'depth' => $category->depth,
            'position' => $category->position,
            'is_visible' => $category->is_visible,
            'url_path' => '/c/'.$category->slug,
            'product_count' => $productCount,
            'children_count' => $childrenCount,
            'created_at' => UserRef::iso($category->created_at),
            'updated_at' => UserRef::iso($category->updated_at),
        ];
    }

    /** @return array{id: string, name: string, slug: string} */
    public static function ref(Category $category): array
    {
        return ['id' => $category->id, 'name' => $category->name, 'slug' => $category->slug];
    }
}
