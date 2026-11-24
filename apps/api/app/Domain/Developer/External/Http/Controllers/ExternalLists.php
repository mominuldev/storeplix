<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use Closure;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-4 §3 / openapi 1.12.0: external lists keep the merchant list shapes (data items AND `*ListMeta`). The merchant
 * list does not know the external-only filters (`filter[updated_since]`, `filter[sku]`), so with one of them the data
 * page is built here (merchant `filtered()` query + presenter) and the store-wide meta parts (counts, summary, plan)
 * come from the merchant list itself, called without those filters and with `per_page=1`; the pagination numbers are
 * the external page's. Without them the merchant list answers directly.
 */
trait ExternalLists
{
    /** @return array<string, mixed> the external-only `filter[...]` values present on the request */
    private static function externalFilters(Request $request, array $keys): array
    {
        $filter = $request->query('filter');

        return is_array($filter) ? array_intersect_key($filter, array_flip($keys)) : [];
    }

    /** `filter[updated_since]` → UTC instant (422 when not a date). */
    private static function updatedSince(Request $request): ?Carbon
    {
        $input = $request->validate(['filter.updated_since' => ['sometimes', 'date']]);
        $value = $input['filter']['updated_since'] ?? null;

        return $value === null ? null : Carbon::parse($value)->utc();
    }

    /** The merchant list's response for the request minus the external-only filters (store-wide meta). */
    private static function merchantList(Request $request, array $strip, Closure $index, bool $metaOnly): JsonResponse
    {
        $query = $request->query();
        if (isset($query['filter']) && is_array($query['filter'])) {
            $query['filter'] = array_diff_key($query['filter'], array_flip($strip));
            if ($query['filter'] === []) {
                unset($query['filter']);
            }
        }
        if ($metaOnly) {
            $query['per_page'] = 1;
            $query['page'] = 1;
        }
        $sub = Request::create('/'.$request->path(), 'GET', $query);
        $sub->setRouteResolver($request->getRouteResolver());
        $sub->setUserResolver($request->getUserResolver());

        return $index($sub);
    }

    /**
     * @param  array<int, mixed>  $items
     * @param  array<string, mixed>  $merchantMeta
     */
    private static function page(LengthAwarePaginator $page, array $items, array $merchantMeta): JsonResponse
    {
        return new JsonResponse([
            'data' => $items,
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ] + $merchantMeta,
        ]);
    }

    /** @return array<string, mixed> */
    private static function metaOf(JsonResponse $response): array
    {
        $meta = $response->getData(true)['meta'] ?? [];

        return is_array($meta) ? $meta : [];
    }
}
