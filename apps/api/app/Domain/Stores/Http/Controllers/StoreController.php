<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Shared\Http\Paginated;
use App\Domain\Stores\Http\Requests\StoreStoreRequest;
use App\Domain\Stores\Http\Resources\StoreResource;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class StoreController
{
    public function index(Request $request): JsonResponse
    {
        Gate::authorize('viewAny', Store::class);

        $perPage = max(1, min(100, (int) $request->integer('per_page', 20)));

        $stores = Store::query() // tenant-scoped by BelongsToTenant
            ->with('primaryDomain')
            ->orderBy('created_at')
            ->orderBy('id')
            ->paginate($perPage);

        return Paginated::response($stores, StoreResource::class);
    }

    public function store(StoreStoreRequest $request, StoreProvisioner $provisioner, TenantContext $context): JsonResponse
    {
        $store = $provisioner->provision($context->tenant(), $request->validated());

        return (new StoreResource($store))->response()->setStatusCode(201);
    }

    public function show(Store $store): StoreResource
    {
        Gate::authorize('view', $store);

        return new StoreResource($store->loadMissing('primaryDomain'));
    }
}
