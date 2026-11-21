<?php

namespace App\Domain\Shared\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Pagination\LengthAwarePaginator;

/**
 * Builds the contract pagination envelope: { data: [...], meta: { current_page, per_page, total, last_page } }.
 */
final class Paginated
{
    /**
     * @param  class-string<JsonResource>  $resource
     */
    public static function response(LengthAwarePaginator $paginator, string $resource): JsonResponse
    {
        return new JsonResponse([
            'data' => $resource::collection($paginator->getCollection())->resolve(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }
}
