<?php

namespace App\Domain\Returns\Http;

use App\Domain\Geo\AddressValidator;
use App\Domain\Orders\Http\OrderController;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Returns\ReturnPresenter;
use App\Domain\Returns\ReturnService;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

/**
 * Returns & exchanges (PHASE-5B §4.9, Figma 39:9900 / 146:32329). O A S (`Operate`); an exchange order with a
 * negative price difference needs `ManageRefunds` (checked in ReturnService). Refunds go through the order refunds
 * endpoint with `return_id`.
 */
class ReturnController
{
    private const PROVIDERS = ['steadfast', 'pathao', 'redx', 'manual'];

    public function __construct(
        private readonly ReturnService $returns,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $list = fn (array $values) => 'regex:/^('.implode('|', $values).')(,('.implode('|', $values).'))*$/';
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,type,reason,provider'],
            'filter.status' => ['sometimes', 'string', $list([...ReturnRequest::STATUSES, 'open'])],
            'filter.type' => ['sometimes', 'string', $list(ReturnRequest::TYPES)],
            'filter.reason' => ['sometimes', 'string', $list(ReturnRequest::REASONS)],
            'filter.provider' => ['sometimes', 'string', $list(self::PROVIDERS)],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:-created_at'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = $input['filter'] ?? [];
        $q = trim((string) ($input['q'] ?? ''));

        $page = $this->filtered($store, $filter, $q, withStatus: true)->with(ReturnPresenter::WITH)
            ->orderByDesc('created_at')->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 25));
        $orderIds = $page->getCollection()->pluck('order_id')->unique()->values()->all();
        $couriers = $orderIds === [] ? [] : Shipment::query()->whereIn('order_id', $orderIds)->where('status', '<>', 'cancelled')
            ->orderBy('created_at')->pluck('provider', 'order_id')->all();

        $byStatus = $this->filtered($store, $filter, $q, withStatus: false)->toBase()->reorder()
            ->groupBy('status')->selectRaw('status, count(*) as aggregate')->pluck('aggregate', 'status');
        $counts = ['open' => 0];
        foreach (ReturnRequest::STATUSES as $status) {
            $counts[$status] = (int) ($byStatus[$status] ?? 0);
            if (in_array($status, ReturnRequest::OPEN, true)) {
                $counts['open'] += $counts[$status];
            }
        }

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (ReturnRequest $r) => ReturnPresenter::summary($r, $couriers))->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $counts,
                'kpis' => $this->kpis($store),
            ],
        ]);
    }

    public function store(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'type' => ['required', 'string', Rule::in(ReturnRequest::TYPES)],
            'reason' => ['required', 'string', Rule::in(ReturnRequest::REASONS)],
            'customer_note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'lines' => ['required', 'array', 'min:1', 'max:50'],
            'lines.*' => ['array:order_item_id,quantity,exchange_variant_id'],
            'lines.*.order_item_id' => ['required', 'string', 'max:26'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:99'],
            'lines.*.exchange_variant_id' => ['sometimes', 'nullable', 'string', 'max:26'],
        ]);
        $input['customer_note'] = AddressValidator::clean($input['customer_note'] ?? null);
        $return = $this->returns->create($order, $input, $request->user());

        return $this->one($return, 201);
    }

    public function show(Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->one($return);
    }

    public function approve(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'pickup_tracking_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        return $this->one($this->returns->approve($return, AddressValidator::clean($input['pickup_tracking_code'] ?? null), AddressValidator::clean($input['note'] ?? null), $request->user()));
    }

    public function reject(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['reason' => ['required', 'string', 'min:1', 'max:255']]);

        return $this->one($this->returns->reject($return, (string) AddressValidator::clean($input['reason']), $request->user()));
    }

    public function receive(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'checks' => ['required', 'array:tags_intact,unused,original_packaging'],
            'checks.tags_intact' => ['required', 'boolean'],
            'checks.unused' => ['required', 'boolean'],
            'checks.original_packaging' => ['required', 'boolean'],
            'lines' => ['required', 'array', 'min:1', 'max:50'],
            'lines.*' => ['array:return_item_id,order_item_id,quantity,restock_quantity'],
            'lines.*.return_item_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'lines.*.order_item_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'lines.*.quantity' => ['sometimes', 'nullable', 'integer:strict', 'min:1', 'max:99'],
            'lines.*.restock_quantity' => ['required', 'integer:strict', 'min:0', 'max:99'],
        ]);

        return $this->one($this->returns->receive($return, $input, $request->user()));
    }

    public function close(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['note' => ['sometimes', 'nullable', 'string', 'max:500']]);

        return $this->one($this->returns->close($return, AddressValidator::clean($input['note'] ?? null), $request->user()));
    }

    public function exchangeOrder(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'shipping_amount_override' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000'],
            'send_payment_link' => ['sometimes', 'nullable', 'array:provider,expires_in_minutes'],
            'send_payment_link.provider' => ['required_with:send_payment_link', 'string', 'in:bkash,sslcommerz'],
            'send_payment_link.expires_in_minutes' => ['required_with:send_payment_link', 'integer', 'in:120,360,1440,2880'],
        ]);
        [$return, $order] = $this->returns->exchange($return, $input, $request->user(), $this->context->permissions(), $request->header(IdempotencyGuard::HEADER));

        return new JsonResponse(['data' => [
            'return' => ReturnPresenter::full(ReturnRequest::query()->whereKey($return->id)->firstOrFail()),
            'order' => OrderPresenter::full(Order::query()->whereKey($order->id)->firstOrFail(), $this->context->permissions()),
            'payment_link' => $this->returns->lastLink !== null ? PaymentPresenter::link($this->returns->lastLink->load('creator'), $store->load('primaryDomain')) : null,
        ]], 201);
    }

    public function addNote(Request $request, Store $store, ReturnRequest $return): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['body' => ['required', 'string', 'min:1', 'max:1000', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u']]);
        $event = $this->returns->note($return, $input['body'], $request->user());

        return new JsonResponse(['data' => ReturnPresenter::event($event->load('actor'))], 201);
    }

    /** @param array<string, string> $filter */
    private function filtered(Store $store, array $filter, string $q, bool $withStatus): Builder
    {
        $query = ReturnRequest::query()->where('return_requests.store_id', $store->id);
        if ($withStatus && isset($filter['status'])) {
            $statuses = explode(',', $filter['status']);
            if (in_array('open', $statuses, true)) {
                $statuses = [...array_diff($statuses, ['open']), ...ReturnRequest::OPEN];
            }
            $query->whereIn('status', array_values(array_unique($statuses)));
        }
        foreach (['type', 'reason'] as $key) {
            if (isset($filter[$key])) {
                $query->whereIn($key, explode(',', $filter[$key]));
            }
        }
        if (isset($filter['provider'])) {
            $providers = explode(',', $filter['provider']);
            $query->whereIn('order_id', Shipment::query()->select('order_id')->where('store_id', $store->id)
                ->where('status', '<>', 'cancelled')->whereIn('provider', $providers));
        }
        if ($q !== '') {
            $query->where(function (Builder $w) use ($store, $q) {
                if (preg_match('/^RT-?0*(\d{1,9})$/i', $q, $m) === 1) {
                    $w->where('sequence', (int) $m[1]);
                }
                $w->orWhereIn('order_id', OrderController::filtered($store, [], $q, false)->select('orders.id'));
            });
        }

        return $query;
    }

    /** @return array{open: int, return_rate_30d: float|null, money_lost_amount: int, restocked_units_month: int} */
    private function kpis(Store $store): array
    {
        $since = now()->subDays(30);
        $open = ReturnRequest::query()->where('store_id', $store->id)->whereIn('status', ReturnRequest::OPEN)->count();
        $returns30 = ReturnRequest::query()->where('store_id', $store->id)->where('status', '<>', ReturnRequest::REJECTED)->where('created_at', '>=', $since)->count();
        $delivered30 = Order::query()->where('store_id', $store->id)->where('delivered_at', '>=', $since)->count();
        $lost = (int) ReturnRequest::query()->where('store_id', $store->id)->where('created_at', '>=', $since)->sum('refunded_amount');
        $monthStart = Carbon::now($store->timezone ?: 'Asia/Dhaka')->startOfMonth()->utc();
        $restocked = (int) DB::table('return_items')
            ->join('return_requests', 'return_requests.id', '=', 'return_items.return_request_id')
            ->where('return_requests.store_id', $store->id)
            ->where('return_requests.received_at', '>=', $monthStart)
            ->sum('return_items.restocked_quantity');

        return [
            'open' => $open,
            'return_rate_30d' => $delivered30 > 0 ? round($returns30 / $delivered30, 4) : null,
            'money_lost_amount' => $lost,
            'restocked_units_month' => $restocked,
        ];
    }

    private function one(ReturnRequest $return, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => ReturnPresenter::full(ReturnRequest::query()->whereKey($return->id)->firstOrFail())], $status);
    }
}
