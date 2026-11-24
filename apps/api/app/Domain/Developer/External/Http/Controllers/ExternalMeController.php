<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Developer\ApiKeys\Http\Resources\ApiKeyResource;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/** PHASE-8-4 §3 GET /external/me: the key's identity and the tenant's (single) store (P84-1). */
class ExternalMeController
{
    public function __invoke(CurrentApiKey $current): JsonResponse
    {
        $key = $current->get() ?? throw new \LogicException('apikey middleware missing');
        $store = Store::query()->orderBy('created_at')->first();

        return new JsonResponse(['data' => ApiKeyResource::identity($key, $store)]);
    }
}
