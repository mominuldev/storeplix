<?php

declare(strict_types=1);

namespace App\Domain\Automations\Http\Controllers;

use App\Domain\Automations\AutomationService;
use App\Domain\Automations\AutomationStats;
use App\Domain\Automations\DryRun;
use App\Domain\Automations\Http\Resources\AutomationPresenter;
use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-6 §9.1 `/stores/{store}/automations…` (perm:marketing.manage). `{automation}` resolves inside the store and
 * the tenant: another store's or tenant's id → 404 `not_found`. Create, PATCH, enable and disable return
 * AutomationDetail (C3).
 */
class AutomationController
{
    public function __construct(
        private readonly AutomationService $automations,
        private readonly TenantContext $context,
    ) {}

    public function index(Store $store): JsonResponse
    {
        $rows = Automation::query()->where('store_id', $store->id)->get()
            ->sortBy(fn (Automation $a) => array_search($a->recipe, RecipeCatalogue::KEYS, true))->values();
        $runs = AutomationStats::runs7d($rows->pluck('id')->all());
        $plan = $this->planAllows();

        return new JsonResponse([
            'data' => $rows->map(fn (Automation $a) => AutomationPresenter::automation($a, $runs, $plan))->all(),
            'meta' => [
                'recipes' => AutomationPresenter::recipeCards($rows->pluck('recipe')->all()),
                'kpis' => AutomationStats::kpis($store),
            ],
        ]);
    }

    public function store(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate(['recipe' => ['required', 'string', Rule::in(RecipeCatalogue::KEYS)]]);

        return $this->detail($this->automations->create($store, $input['recipe'], $request->user()), 201);
    }

    public function show(Store $store, string $automation): JsonResponse
    {
        return $this->detail(self::find($store, $automation));
    }

    public function update(Request $request, Store $store, string $automation): JsonResponse
    {
        $row = self::find($store, $automation);
        $input = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:80', 'not_regex:/[\x00-\x1F\x7F]/'],
            'settings' => ['sometimes', 'present'],
            'revision' => ['required', 'integer'],
        ]);
        $changes = [];
        if (array_key_exists('name', $input)) {
            $changes['name'] = $input['name'];
        }
        if ($request->exists('settings')) {
            $changes['settings'] = $request->input('settings'); // validated whole by the recipe schema (unknown keys → 422)
        }

        return $this->detail($this->automations->update($store, $row, $changes, (int) $input['revision']));
    }

    public function enable(Store $store, string $automation): JsonResponse
    {
        return $this->detail($this->automations->enable($store, self::find($store, $automation)));
    }

    public function disable(Store $store, string $automation): JsonResponse
    {
        return $this->detail($this->automations->disable(self::find($store, $automation)));
    }

    public function destroy(Store $store, string $automation): Response
    {
        $this->automations->delete(self::find($store, $automation));

        return response()->noContent();
    }

    public function dryRun(Request $request, Store $store, string $automation): JsonResponse
    {
        $row = self::find($store, $automation);
        $input = $request->validate([
            'order_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'cart_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'inventory_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'return_id' => ['sometimes', 'nullable', 'string', 'size:26'],
        ]);

        return new JsonResponse(['data' => DryRun::run($store, $row, $input)]);
    }

    public function testMessage(Request $request, Store $store, string $automation): JsonResponse
    {
        $row = self::find($store, $automation);
        $input = $request->validate(['step' => ['sometimes', 'integer', 'in:1,2']]);

        return new JsonResponse(['data' => $this->automations->test($store, $row, $request->user(), (int) ($input['step'] ?? 1))], 202);
    }

    public function stats(Request $request, Store $store, string $automation): JsonResponse
    {
        $row = self::find($store, $automation);
        $input = $request->validate(['days' => ['sometimes', 'integer', 'in:14,30']]);

        return new JsonResponse(['data' => AutomationStats::stats($store, $row, (int) ($input['days'] ?? 14))]);
    }

    public static function find(Store $store, string $id): Automation
    {
        return Automation::query()->where('store_id', $store->id)->whereKey(strtolower($id))->firstOrFail();
    }

    private function detail(Automation $automation, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => AutomationPresenter::detail($automation->refresh(), $this->planAllows())], $status);
    }

    private function planAllows(): bool
    {
        $tenant = $this->context->tenant();

        return $tenant !== null && FeatureGate::allows($tenant, Feature::SmsAutomation);
    }
}
