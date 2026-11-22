<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Stores\Http\Resources\StoreResource;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\LaunchChecklist;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

/** §3.8 go-live: checklist (O A S) and publish (O A, ManageSettings). */
class LaunchController
{
    public function __construct(private readonly LaunchChecklist $checklist) {}

    public function checklist(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => $this->checklist->present($store)]);
    }

    public function publish(Store $store): JsonResponse
    {
        Gate::authorize('update', $store);
        $store = $this->checklist->publish($store);

        return new JsonResponse(['data' => (new StoreResource($store->loadMissing('primaryDomain')))->resolve()]);
    }
}
