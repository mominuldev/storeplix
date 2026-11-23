<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Http\Resources\StorefrontConfigResource;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\ResolvedStorefront;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class StorefrontConfigController
{
    public function __invoke(Request $request): StorefrontConfigResource|JsonResponse
    {
        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);

        // PHASE-8-1 §4.1 (P8-12, Q101): StorefrontSuspended — nothing else (no name, theme or contact) and never cached.
        if ($resolved->suspended) {
            return new JsonResponse(['data' => ['availability' => 'suspended']], 200, ['Cache-Control' => 'private, no-store']);
        }

        // Tenant-scoped query: the TenantContext was set from the validated host.
        $store = Store::query()->with(['settings', 'primaryDomain'])->findOrFail($resolved->storeId);

        return new StorefrontConfigResource($store);
    }
}
