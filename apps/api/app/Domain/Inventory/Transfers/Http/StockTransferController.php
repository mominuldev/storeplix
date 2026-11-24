<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers\Http;

use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Inventory\Transfers\StockTransferPresenter;
use App\Domain\Inventory\Transfers\StockTransferService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-8C §7, §9 `/stores/{store}/stock-transfers…`. Reads: every member (`perm:base`); writes `inventory.adjust`.
 * `{transfer}` resolves inside the store and tenant: another store's or tenant's id → 404 `not_found` (S187). Every
 * write returns the StockTransferDetail.
 */
class StockTransferController
{
    public const PER_PAGE = 25;

    public function __construct(private readonly StockTransferService $transfers) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', StockTransfer::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,location_id'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.location_id' => ['sometimes', 'string', 'size:26'],
            'q' => ['sometimes', 'nullable', 'string', 'max:40'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $base = StockTransfer::query()->where('store_id', $store->id);
        if (isset($input['filter']['location_id'])) {
            $loc = strtolower($input['filter']['location_id']);
            $base->where(fn ($w) => $w->where('from_location_id', $loc)->orWhere('to_location_id', $loc));
        }
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $base->whereRaw("lower(number) like ? escape '\\'", [$like]);
        }
        $counts = (clone $base)->toBase()->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status');
        $page = (clone $base)
            ->when(isset($input['filter']['status']), fn ($w) => $w->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->paginate((int) ($input['per_page'] ?? self::PER_PAGE));

        $byStatus = ['all' => (int) $counts->sum()];
        foreach (StockTransfer::STATUSES as $status) {
            $byStatus[$status] = (int) ($counts[$status] ?? 0);
        }

        return new JsonResponse([
            'data' => StockTransferPresenter::many($page->getCollection()),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $byStatus,
            ],
        ], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function summary(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => StockTransferPresenter::summary($store)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function show(Store $store, string $transfer): JsonResponse
    {
        return $this->detail(self::find($store, $transfer));
    }

    public function store(StockTransferRequest $request, Store $store): JsonResponse
    {
        return $this->detail($this->transfers->create($store, $request->validated(), $request->user()), 201);
    }

    public function update(StockTransferRequest $request, Store $store, string $transfer): JsonResponse
    {
        return $this->detail($this->transfers->update($store, self::find($store, $transfer), $request->validated(), $request->user()));
    }

    public function destroy(TransferTransitionRequest $request, Store $store, string $transfer): Response
    {
        $this->transfers->delete($store, self::find($store, $transfer));

        return response()->noContent();
    }

    public function send(TransferTransitionRequest $request, Store $store, string $transfer): JsonResponse
    {
        return $this->detail($this->transfers->send($store, self::find($store, $transfer), $request->revision(), $request->user()));
    }

    public function receive(TransferTransitionRequest $request, Store $store, string $transfer): JsonResponse
    {
        /** @var list<array{item_id: string, received: int}> $lines */
        $lines = $request->validated('lines');

        return $this->detail($this->transfers->receive($store, self::find($store, $transfer), $lines, $request->revision(), $request->user()));
    }

    public function cancel(TransferTransitionRequest $request, Store $store, string $transfer): JsonResponse
    {
        return $this->detail($this->transfers->cancel($store, self::find($store, $transfer), $request->revision(), $request->user()));
    }

    public static function find(Store $store, string $id): StockTransfer
    {
        $row = StockTransfer::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    private function detail(StockTransfer $transfer, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => StockTransferPresenter::detail($transfer->refresh())], $status, ['Cache-Control' => 'private, no-store']);
    }
}
