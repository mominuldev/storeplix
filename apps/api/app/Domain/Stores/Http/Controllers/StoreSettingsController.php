<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Stores\Http\Requests\UpdateStoreSettingsRequest;
use App\Domain\Stores\Http\Resources\StoreSettingsPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Services\StoreSettingsUpdater;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

class StoreSettingsController
{
    public function show(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => StoreSettingsPresenter::present($store, $this->settings($store))]);
    }

    public function update(UpdateStoreSettingsRequest $request, Store $store, StoreSettingsUpdater $updater): JsonResponse
    {
        $settings = $this->settings($store);
        $updater->update($store, $settings, $request->validated());

        return new JsonResponse(['data' => StoreSettingsPresenter::present($store->refresh(), $settings->refresh())]);
    }

    private function settings(Store $store): StoreSetting
    {
        return StoreSetting::query()->firstOrCreate(['store_id' => $store->id]);
    }
}
