<?php

namespace App\Domain\Pages\Http\Resources;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Pages\PageBodyValidator;
use App\Domain\Shared\Http\UserRef;

/** StorePageSummary / StorePage / StorefrontPage payloads. */
final class StorePagePresenter
{
    /**
     * @param  iterable<StoreNavigation>  $menus
     * @return array<string, mixed>
     */
    public static function summary(StorePage $page, iterable $menus): array
    {
        $page->loadMissing('updatedBy');

        return [
            'id' => $page->id,
            'title' => $page->title,
            'slug' => $page->slug,
            'url_path' => '/pages/'.$page->slug,
            'status' => $page->status,
            'template' => $page->template,
            'in_menus' => NavigationService::menusContaining($page->id, $menus),
            'revision' => $page->revision,
            'published_at' => UserRef::iso($page->published_at),
            'updated_at' => UserRef::iso($page->updated_at),
            'updated_by' => UserRef::of($page->updatedBy),
        ];
    }

    /**
     * @param  iterable<StoreNavigation>  $menus
     * @return array<string, mixed>
     */
    public static function full(StorePage $page, iterable $menus): array
    {
        $page->loadMissing('ogImage');

        return self::summary($page, $menus) + [
            'body' => $page->body ?? [],
            'seo' => [
                'title' => $page->seo_title,
                'description' => $page->seo_description,
                'share_image' => MediaPresenter::ref($page->ogImage),
            ],
            'media' => MediaMaps::refs(PageBodyValidator::mediaIds($page->body ?? [])),
        ];
    }

    /** @return array<string, mixed> StorefrontPage */
    public static function storefront(StorePage $page): array
    {
        $page->loadMissing('ogImage');

        return [
            'id' => $page->id,
            'slug' => $page->slug,
            'title' => $page->title,
            'status' => $page->status,
            'body' => $page->body ?? [],
            'media' => MediaMaps::storefront(PageBodyValidator::mediaIds($page->body ?? [])),
            'seo' => [
                'title' => $page->seo_title,
                'description' => $page->seo_description,
                'og_image_url' => MediaPresenter::url($page->ogImage, ['w1600', 'w1024']),
            ],
            'updated_at' => UserRef::iso($page->updated_at),
        ];
    }
}
