<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Pages\Http\Resources\StorePagePresenter;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Services\ResolvedStorefront;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Storefront pages (§3.7). Tenant + store come only from the validated X-Storefront-Host. */
class StorefrontPageController
{
    /** GET /storefront/pages — published pages only, always (sitemap). */
    public function index(Request $request): JsonResponse
    {
        $pages = StorePage::query()
            ->where('store_id', $this->resolved($request)->storeId)
            ->where('status', StorePage::PUBLISHED)
            ->orderBy('slug')
            ->limit(StorePage::MAX_PER_STORE)
            ->get(['slug', 'updated_at']);

        return new JsonResponse(['data' => $pages->map(fn (StorePage $p) => [
            'slug' => $p->slug,
            'updated_at' => $p->updated_at?->toIso8601ZuluString(),
        ])->all()]);
    }

    /** GET /storefront/pages/{slug} — public: published only; valid preview: any status. */
    public function show(Request $request, string $slug): JsonResponse
    {
        $notFound = new ApiException(404, 'page_not_found', 'Page not found.');

        if (strlen($slug) > 80 || preg_match(StorePage::SLUG_PATTERN, $slug) !== 1) {
            throw $notFound;
        }

        $preview = (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false);
        $page = StorePage::query()
            ->where('store_id', $this->resolved($request)->storeId)
            ->where('slug', $slug)
            ->when(! $preview, fn ($q) => $q->where('status', StorePage::PUBLISHED))
            ->first() ?? throw $notFound;

        return new JsonResponse(['data' => StorePagePresenter::storefront($page)]);
    }

    private function resolved(Request $request): ResolvedStorefront
    {
        return $request->attributes->get(ResolveStorefront::ATTRIBUTE);
    }
}
