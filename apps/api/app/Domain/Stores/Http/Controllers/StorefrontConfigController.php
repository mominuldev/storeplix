<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Http\Resources\StorefrontConfigResource;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\ResolvedStorefront;
use Illuminate\Http\Request;

class StorefrontConfigController
{
    public function __invoke(Request $request): StorefrontConfigResource
    {
        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);

        // Tenant-scoped query: the TenantContext was set from the validated host.
        $store = Store::query()->with('settings')->findOrFail($resolved->storeId);

        return new StorefrontConfigResource($store);
    }
}
