<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Http\Controllers;

use App\Domain\Inventory\Http\Requests\LocationRequest;
use App\Domain\Inventory\Http\Resources\LocationPresenter;
use App\Domain\Inventory\Locations\LocationService;
use App\Domain\Inventory\Models\Location;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-8C §4, §9 `/stores/{store}/locations…`. Reads: every member (`perm:base`); writes: `settings.manage`.
 * `{location}` resolves inside the store and the tenant: another store's or tenant's id → 404 `not_found` (S179).
 * List (not paginated): default first, then position, then name; `filter[archived]` omitted = every location.
 */
class LocationController
{
    public function __construct(
        private readonly LocationService $locations,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array:archived'],
            'filter.archived' => ['sometimes', 'string', 'in:true,false,1,0'],
        ]);
        $archived = $input['filter']['archived'] ?? null;
        $rows = Location::query()->where('store_id', $store->id)
            ->when($archived !== null, fn ($q) => in_array($archived, ['true', '1'], true) ? $q->whereNotNull('archived_at') : $q->whereNull('archived_at'))
            ->with('pickupLocation')
            ->orderByDesc('is_default')->orderByRaw('CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END')->orderBy('position')->orderBy('name')->orderBy('id')
            ->get();

        return new JsonResponse(['data' => LocationPresenter::many($store->id, $rows, $this->costs())], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(LocationRequest $request, Store $store): JsonResponse
    {
        $row = $this->locations->create($store, $request->validated(), $request->user());

        return new JsonResponse(['data' => $this->present($row)], 201);
    }

    public function update(LocationRequest $request, Store $store, string $location): JsonResponse
    {
        return new JsonResponse(['data' => $this->present($this->locations->update($store, self::find($store, $location), $request->validated()))]);
    }

    public function archive(Store $store, string $location): JsonResponse
    {
        return new JsonResponse(['data' => $this->present($this->locations->archive($store, self::find($store, $location)))]);
    }

    public function unarchive(Store $store, string $location): JsonResponse
    {
        return new JsonResponse(['data' => $this->present($this->locations->unarchive($store, self::find($store, $location)))]);
    }

    public function makeDefault(Store $store, string $location): JsonResponse
    {
        return new JsonResponse(['data' => $this->present($this->locations->makeDefault($store, self::find($store, $location)))]);
    }

    public static function find(Store $store, string $id): Location
    {
        $row = Location::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    /** @return array<string, mixed> */
    private function present(Location $row): array
    {
        return LocationPresenter::one($row->refresh()->load('pickupLocation'), $this->costs());
    }

    private function costs(): bool
    {
        return $this->context->allows(Permission::CostsView);
    }
}
