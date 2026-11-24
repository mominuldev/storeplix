<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Counts\Http;

use App\Domain\Inventory\Counts\StockCountPresenter;
use App\Domain\Inventory\Counts\StockCountService;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockCountItem;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-8C §8, §9 `/stores/{store}/stock-counts…`. Reads: every member (`perm:base`); writes `inventory.adjust`; every
 * value only with `costs.view` (S191). `{count}` / `{line}` resolve inside the store, tenant and count, else 404
 * `not_found` (S187). No plan gate.
 */
class StockCountController
{
    public const PER_PAGE = 25;

    public function __construct(
        private readonly StockCountService $counts,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', StockCount::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,location_id'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.location_id' => ['sometimes', 'string', 'size:26'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $base = StockCount::query()->where('store_id', $store->id)
            ->when(isset($input['filter']['location_id']), fn ($q) => $q->where('location_id', strtolower($input['filter']['location_id'])));
        $counts = (clone $base)->toBase()->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status');
        $page = (clone $base)
            ->when(isset($input['filter']['status']), fn ($w) => $w->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderByDesc('started_at')->orderByDesc('id')
            ->paginate((int) ($input['per_page'] ?? self::PER_PAGE));

        $byStatus = ['all' => (int) $counts->sum()];
        foreach (StockCount::STATUSES as $status) {
            $byStatus[$status] = (int) ($counts[$status] ?? 0);
        }

        return new JsonResponse([
            'data' => StockCountPresenter::many($store, $page->getCollection(), $this->costs()),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $byStatus,
            ],
        ], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function show(Store $store, string $count): JsonResponse
    {
        return $this->detail($store, self::find($store, $count));
    }

    public function lines(Request $request, Store $store, string $count): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array:state'],
            'filter.state' => ['sometimes', 'string', Rule::in(['not_counted', 'differences', 'matched'])],
            'q' => ['sometimes', 'nullable', 'string', 'max:120'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:'.StockCountPresenter::LINES_PER_PAGE],
        ]);
        $result = StockCountPresenter::lines(self::find($store, $count), $input['filter']['state'] ?? null, $input['q'] ?? null,
            (int) ($input['per_page'] ?? StockCountPresenter::LINES_PER_PAGE), $this->costs());

        return new JsonResponse($result, 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(StockCountRequest $request, Store $store): JsonResponse
    {
        return $this->detail($store, $this->counts->start($store, $request->validated(), $request->user()), 201);
    }

    public function scan(StockCountRequest $request, Store $store, string $count): JsonResponse
    {
        $row = self::find($store, $count);
        $line = $this->counts->scan($store, $row, (string) $request->validated('code'), $request->user());

        return $this->lineResult($store, $row, $line);
    }

    public function setLine(StockCountRequest $request, Store $store, string $count, string $line): JsonResponse
    {
        $row = self::find($store, $count);
        $counted = $request->validated('counted');
        $item = $this->counts->setLine($store, $row, $line, $counted === null ? null : (int) $counted, $request->revision(), $request->user());

        return $this->lineResult($store, $row, $item);
    }

    public function finish(StockCountRequest $request, Store $store, string $count): JsonResponse
    {
        $row = $this->counts->finish($store, self::find($store, $count), (bool) $request->validated('zero_uncounted'), $request->revision(), $request->user(), $this->costs());

        return $this->detail($store, $row);
    }

    public function cancel(StockCountRequest $request, Store $store, string $count): JsonResponse
    {
        return $this->detail($store, $this->counts->cancel($store, self::find($store, $count), $request->revision(), $request->user()));
    }

    public static function find(Store $store, string $id): StockCount
    {
        $row = StockCount::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    private function lineResult(Store $store, StockCount $count, StockCountItem $line): JsonResponse
    {
        $count->refresh()->load(['location', 'category', 'startedBy', 'finishedBy']);
        $costs = $this->costs();
        $summary = StockCountPresenter::summary($count, $costs);

        return new JsonResponse(['data' => [
            'line' => StockCountPresenter::line($count, $line->refresh(), $costs),
            'summary' => $summary,
            'count' => StockCountPresenter::one($store, $count, $costs, $summary['net_value_amount'] ?? 0),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    private function detail(Store $store, StockCount $count, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => StockCountPresenter::detail($store, $count->refresh(), $this->costs())], $status, ['Cache-Control' => 'private, no-store']);
    }

    private function costs(): bool
    {
        return $this->context->allows(Permission::CostsView);
    }
}
