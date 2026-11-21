<?php

namespace App\Domain\Themes\Http\Controllers;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Themes\Http\Requests\SaveThemeDraftRequest;
use App\Domain\Themes\Http\Resources\StoreThemePresenter;
use App\Domain\Themes\Models\StoreTheme;
use App\Domain\Themes\StoreThemeService;
use App\Domain\Themes\ThemeConfigValidator;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class StoreThemeController
{
    public function __construct(private readonly StoreThemeService $themes) {}

    /** GET /stores/{store}/themes → StoreThemeSummary[] (active first). */
    public function index(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $this->themes->active($store);

        $rows = StoreTheme::query()->where('store_id', $store->id)
            ->orderByDesc('is_active')->orderBy('theme_code')->get();

        return new JsonResponse(['data' => $rows->map(StoreThemePresenter::summary(...))->all()]);
    }

    public function show(Store $store, string $code): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->ok($this->find($store, $code));
    }

    public function saveDraft(SaveThemeDraftRequest $request, Store $store, string $code, ThemeConfigValidator $validator): JsonResponse
    {
        $theme = $this->find($store, $code);
        $config = $validator->validate($code, $request->rawConfig() ?? $request->validated('config'));

        return $this->ok($this->themes->saveDraft($theme, $config, (int) $request->validated('base_revision'), $request->user()));
    }

    public function publish(Request $request, Store $store, string $code): JsonResponse
    {
        Gate::authorize('update', $store);
        $theme = $this->find($store, $code);
        $input = $request->validate(['draft_revision' => ['required', 'integer', 'min:1']]);

        return $this->ok($this->themes->publish($theme, (int) $input['draft_revision'], $request->user()));
    }

    public function discard(Store $store, string $code): JsonResponse
    {
        Gate::authorize('update', $store);

        return $this->ok($this->themes->discard($this->find($store, $code)));
    }

    public function apply(Request $request, Store $store, string $code): JsonResponse
    {
        Gate::authorize('update', $store);

        return $this->ok($this->themes->apply($store, $code, $request->user()));
    }

    private function find(Store $store, string $code): StoreTheme
    {
        $this->themes->active($store); // lazily installs the default theme for legacy stores

        return StoreTheme::query()->where('store_id', $store->id)->where('theme_code', $code)->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private function ok(StoreTheme $theme): JsonResponse
    {
        return new JsonResponse(['data' => StoreThemePresenter::full($theme->refresh())]);
    }
}
