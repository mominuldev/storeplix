<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Couriers\BookingService;
use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Jobs\RunBulkBooking;
use App\Domain\Couriers\Jobs\SyncCourierAccount;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Couriers\ShipmentPresenter;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Shipments (PHASE-5B §4.7; merchant, O A S `Operate` unless stated). `{shipment}` / `{batch}` / `{order}` of another
 * store or tenant → 404; ids inside a body that aren't this store's → 422 on that path (never 403).
 */
class ShipmentController
{
    private const PROVIDERS = ['steadfast', 'pathao', 'redx'];

    private const LIST_PROVIDERS = ['steadfast', 'pathao', 'redx', 'manual'];

    public function __construct(
        private readonly BookingService $booking,
        private readonly ShipmentSync $sync,
        private readonly CourierManager $couriers,
        private readonly TenantContext $context,
    ) {}

    /** POST /stores/{store}/orders/{order}/shipments (Idempotency-Key via the `idempotent` middleware). */
    public function store(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        // S39: only these keys are read; status, consignment_id, cod_collected_amount are never taken from input.
        $input = $request->validate([
            'provider' => ['required', 'string', Rule::in(self::PROVIDERS)],
            'pickup_location_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'cod_amount' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000000000'],
            'weight_grams' => ['sometimes', 'nullable', 'integer:strict', 'min:1', 'max:100000'],
            'item_description' => ['sometimes', 'nullable', 'string', 'max:120'],
            'note' => ['sometimes', 'nullable', 'string', 'max:255'],
            'delivery_type' => ['sometimes', 'nullable', 'integer', 'in:48,12'],
            'area' => ['sometimes', 'nullable', 'array:city_id,zone_id,area_id'],
            'area.city_id' => ['sometimes', 'nullable', 'string', 'max:32'],
            'area.zone_id' => ['sometimes', 'nullable', 'string', 'max:32'],
            'area.area_id' => ['sometimes', 'nullable', 'string', 'max:32'],
            'remember_area' => ['sometimes', 'boolean'],
        ]);
        if ($input['provider'] === CourierAccount::PATHAO && isset($input['weight_grams']) && ($input['weight_grams'] < 500 || $input['weight_grams'] > 10000)) {
            throw ValidationException::withMessages(['weight_grams' => ['Pathao takes parcels from 0.5 kg to 10 kg.']]);
        }
        $shipment = $this->booking->book($store, $order, $input, $request->user(), $this->context->role(), $request->header('Idempotency-Key'));

        return new JsonResponse(['data' => ShipmentPresenter::shipment($shipment)], 201);
    }

    /** POST /stores/{store}/shipments/bulk → 202 ShipmentBatch (P5B-40). Plan feature `bulk_courier_booking`. */
    public function bulk(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'provider' => ['required', 'string', Rule::in(self::PROVIDERS)],
            'order_ids' => ['required', 'array', 'min:1', 'max:500'],
            'order_ids.*' => ['required', 'string', 'distinct', 'max:26'],
        ]);
        FeatureGate::assertAllows($this->context->tenant(), Feature::BulkCourierBooking);
        $ids = array_map(fn ($id) => strtolower((string) $id), $input['order_ids']);
        $known = Order::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('id')->flip();
        $errors = [];
        foreach ($ids as $i => $id) {
            if (! isset($known[$id])) {
                $errors["order_ids.{$i}"] = ['Unknown order.'];
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors); // nothing queued
        }
        $account = $this->booking->connectedAccount($store, $input['provider']);

        $batch = new ShipmentBatch;
        $batch->forceFill([
            'store_id' => $store->id,
            'provider' => $account->provider,
            'status' => ShipmentBatch::QUEUED,
            'total' => count($ids),
            'results' => [],
            'created_by' => $request->user()?->getKey(),
        ])->save();
        RunBulkBooking::dispatch($batch->id, $ids)->onQueue(RunBulkBooking::QUEUE)->afterCommit();

        return new JsonResponse(['data' => ShipmentPresenter::batch($batch->refresh())], 202);
    }

    public function batch(Store $store, string $batch): JsonResponse
    {
        Gate::authorize('view', $store);
        $row = ShipmentBatch::query()->where('store_id', $store->id)->whereKey(strtolower($batch))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        return new JsonResponse(['data' => ShipmentPresenter::batch($row)]);
    }

    /** GET /stores/{store}/shipments: filters, groups, sort, counts per provider and KPIs (P5B-43). */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $list = fn (array $values) => 'regex:/^('.implode('|', $values).')(,('.implode('|', $values).'))*$/';
        $input = $request->validate([
            'filter' => ['sometimes', 'array:provider,status,booked_at'],
            'filter.provider' => ['sometimes', 'string', $list(self::LIST_PROVIDERS)],
            'filter.status' => ['sometimes', 'string', $list(array_merge(Shipment::STATUSES, ['problems', 'active', 'final']))],
            'filter.booked_at' => ['sometimes', 'array:gte,lte'],
            'filter.booked_at.gte' => ['sometimes', 'date'],
            'filter.booked_at.lte' => ['sometimes', 'date'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:-booked_at,-cod'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = $input['filter'] ?? [];
        $q = trim((string) ($input['q'] ?? ''));

        $query = $this->filtered($store, $filter, $q, withProvider: true);
        ($input['sort'] ?? '-booked_at') === '-cod'
            ? $query->orderByDesc('shipments.cod_amount')->orderByDesc('shipments.id')
            : $query->orderByRaw('COALESCE(shipments.booked_at, shipments.shipped_at, shipments.created_at) DESC')->orderByDesc('shipments.id');
        $page = $query->select('shipments.*')
            ->with(['order' => fn ($o) => $o->select(['id', 'number', 'customer_name', 'customer_phone', 'shipping_address'])])
            ->paginate((int) ($input['per_page'] ?? 25));

        // Tab counts are store-wide (WEB: counts.all = 0 → empty state), whatever the filters.
        $byProvider = Shipment::query()->where('shipments.store_id', $store->id)->toBase()
            ->groupBy('shipments.provider')->selectRaw('shipments.provider as provider, count(*) as aggregate')->pluck('aggregate', 'provider');
        $counts = ['all' => (int) $byProvider->sum()];
        foreach (self::LIST_PROVIDERS as $provider) {
            $counts[$provider] = (int) ($byProvider[$provider] ?? 0);
        }

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (Shipment $s) => ShipmentPresenter::summary($s))->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $counts,
                'kpis' => $this->kpis($store),
                'last_synced_at' => ($last = CourierAccount::query()->where('store_id', $store->id)->max('last_synced_at')) !== null
                    ? Carbon::parse($last)->toIso8601ZuluString() : null,
            ],
        ]);
    }

    public function show(Store $store, string $shipment): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => $this->detail($this->find($store, $shipment))]);
    }

    /** POST /shipments/{shipment}/refresh: courier status API now (throttle 6/min per shipment). */
    public function refresh(Store $store, string $shipment): JsonResponse
    {
        Gate::authorize('view', $store);
        $row = $this->find($store, $shipment);
        $key = 'shipment-refresh:'.$row->id;
        if (RateLimiter::tooManyAttempts($key, 6)) {
            throw new ApiException(429, 'rate_limited', 'This parcel was refreshed a moment ago. Try again in a minute.', null, max(1, RateLimiter::availableIn($key)));
        }
        RateLimiter::hit($key, 60);
        if ($row->provider !== Shipment::MANUAL && $row->consignment_id !== null && ! $row->isFinal()) {
            try {
                $row = $this->sync->refresh($row, 'user');
            } catch (CourierException $e) {
                throw $e->errorCode === CourierException::PROVIDER_UNAVAILABLE
                    ? new ApiException(502, 'provider_unavailable', 'The courier is not answering. Try again in a few minutes.')
                    : new ApiException(422, $e->errorCode === CourierException::CREDENTIALS_INVALID ? 'credentials_invalid' : 'gateway_not_connected', CourierException::sanitise($e->getMessage()));
            }
        }

        return new JsonResponse(['data' => $this->detail($row)]);
    }

    /** POST /shipments/sync ("Sync now", throttle 1/min per store): one job per connected account. */
    public function syncNow(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $key = 'shipments-sync:'.$store->id;
        if (RateLimiter::tooManyAttempts($key, 1)) {
            throw new ApiException(429, 'rate_limited', 'Shipments were synced a moment ago. Try again in a minute.', null, max(1, RateLimiter::availableIn($key)));
        }
        RateLimiter::hit($key, 60);
        $accounts = CourierAccount::query()->where('store_id', $store->id)->where('status', CourierAccount::CONNECTED)->pluck('id');
        $queued = 0;
        foreach ($accounts as $accountId) {
            $active = Shipment::query()->where('courier_account_id', $accountId)->whereIn('status', ShipmentSync::ACTIVE)->whereNotNull('consignment_id')->count();
            if ($active === 0) {
                continue;
            }
            SyncCourierAccount::dispatch((string) $accountId, true)->onQueue(SyncCourierAccount::QUEUE)->afterCommit();
            $queued += $active;
        }

        return new JsonResponse(['data' => ['queued' => $queued]], 202);
    }

    public function cancel(Request $request, Store $store, string $shipment): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['reason' => ['sometimes', 'nullable', 'string', 'max:255']]);
        $row = $this->booking->cancel($this->find($store, $shipment), $input['reason'] ?? null, $request->user());

        return new JsonResponse(['data' => ShipmentPresenter::shipment($row)]);
    }

    public function markCancelled(Request $request, Store $store, string $shipment): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['note' => ['sometimes', 'nullable', 'string', 'max:255']]);
        $row = $this->booking->markCancelled($this->find($store, $shipment), $input['note'] ?? null, $request->user());

        return new JsonResponse(['data' => ShipmentPresenter::shipment($row)]);
    }

    private function find(Store $store, string $id): Shipment
    {
        return Shipment::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** @return array<string, mixed> */
    private function detail(Shipment $s): array
    {
        $s->loadMissing('order');
        $account = $s->courier_account_id !== null ? CourierAccount::query()->whereKey($s->courier_account_id)->first() : null;
        $canCancel = $account !== null && in_array('cancel', $this->couriers->driver($account->provider)->capabilities(), true);

        return ShipmentPresenter::detail($s, $account, $canCancel);
    }

    /** @param array<string, mixed> $filter */
    private function filtered(Store $store, array $filter, string $q, bool $withProvider): Builder
    {
        $query = Shipment::query()->where('shipments.store_id', $store->id);
        if ($withProvider && isset($filter['provider'])) {
            $query->whereIn('shipments.provider', explode(',', $filter['provider']));
        }
        if (isset($filter['status'])) {
            $values = explode(',', $filter['status']);
            $plain = array_values(array_diff($values, ['problems', 'active', 'final']));
            $query->where(function (Builder $w) use ($values, $plain) {
                if ($plain !== []) {
                    $w->orWhereIn('shipments.status', $plain);
                }
                if (in_array('active', $values, true)) {
                    $w->orWhereIn('shipments.status', Shipment::ACTIVE_STATUSES);
                }
                if (in_array('final', $values, true)) {
                    $w->orWhereIn('shipments.status', Shipment::FINAL_STATUSES);
                }
                if (in_array('problems', $values, true)) {
                    $w->orWhere(fn (Builder $p) => $p->whereNotNull('shipments.problem')->whereNotIn('shipments.status', Shipment::FINAL_STATUSES));
                }
            });
        }
        if (isset($filter['booked_at']['gte'])) {
            $query->where('shipments.booked_at', '>=', Carbon::parse($filter['booked_at']['gte'])->startOfDay()->utc());
        }
        if (isset($filter['booked_at']['lte'])) {
            $query->where('shipments.booked_at', '<=', Carbon::parse($filter['booked_at']['lte'])->endOfDay()->utc());
        }
        if ($q !== '') {
            $digits = ltrim(Phone::clean($q), '+');
            $upper = strtoupper($q);
            $orders = Order::query()->select('id')->where('store_id', $store->id)->where(function (Builder $w) use ($upper, $digits) {
                $w->where('number', 'like', addcslashes($upper, '%_\\').'%');
                if (ctype_digit($digits) && strlen($digits) >= 4) {
                    $phone = str_starts_with($digits, '01') ? '88'.$digits.'%' : (str_starts_with($digits, '8801') ? $digits.'%' : '%'.$digits.'%');
                    $w->orWhere('customer_phone', 'like', $phone);
                }
            });
            $query->where(function (Builder $w) use ($q, $orders) {
                $w->where('shipments.consignment_id', $q)->orWhere('shipments.tracking_code', $q)->orWhereIn('shipments.order_id', $orders);
            });
        }

        return $query;
    }

    /** @return array<string, mixed> ShipmentListMeta.kpis — one aggregate query + one for COD held (P5B-43). */
    private function kpis(Store $store): array
    {
        $now = now();
        $week = $now->copy()->subDays(7);
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $today = Carbon::now($tz)->startOfDay()->utc();
        $final = "'".implode("','", Shipment::FINAL_STATUSES)."'";
        $row = Shipment::query()->where('store_id', $store->id)->toBase()->selectRaw(
            "SUM(CASE WHEN status IN ('picked_up','in_transit') THEN 1 ELSE 0 END) AS in_transit,
             SUM(CASE WHEN status = 'out_for_delivery' AND last_event_at >= ? THEN 1 ELSE 0 END) AS out_today,
             SUM(CASE WHEN status IN ('delivered','partially_delivered') AND delivered_at >= ? THEN 1 ELSE 0 END) AS delivered_7d,
             SUM(CASE WHEN status = 'returned' AND returned_at >= ? THEN 1 ELSE 0 END) AS returned_7d,
             SUM(CASE WHEN problem IS NOT NULL AND status NOT IN ({$final}) THEN 1 ELSE 0 END) AS problems,
             SUM(CASE WHEN problem = 'delivery_failed' AND status NOT IN ({$final}) THEN 1 ELSE 0 END) AS p_failed,
             SUM(CASE WHEN problem = 'on_hold' AND status NOT IN ({$final}) THEN 1 ELSE 0 END) AS p_hold,
             SUM(CASE WHEN problem = 'returning' AND status NOT IN ({$final}) THEN 1 ELSE 0 END) AS p_returning",
            [$today, $week, $week],
        )->first();
        $delivered = (int) ($row->delivered_7d ?? 0);
        $returned = (int) ($row->returned_7d ?? 0);

        $held = Shipment::query()->where('store_id', $store->id)->toBase()
            ->whereIn('status', ['delivered', 'partially_delivered'])->whereNull('settled_at')
            ->where('delivered_at', '>=', $now->copy()->subDays(60))->where('provider', '<>', Shipment::MANUAL)
            ->groupBy('provider')->selectRaw('provider, COALESCE(SUM(cod_collected_amount), 0) AS amount, COUNT(*) AS parcels')->get();
        $byProvider = [];
        foreach (self::PROVIDERS as $provider) {
            $r = $held->firstWhere('provider', $provider);
            if ($r !== null && ((int) $r->parcels > 0)) {
                $byProvider[] = ['provider' => $provider, 'amount' => (int) $r->amount, 'parcels' => (int) $r->parcels];
            }
        }

        return [
            'in_transit' => (int) ($row->in_transit ?? 0),
            'out_for_delivery_today' => (int) ($row->out_today ?? 0),
            'delivered_7d' => $delivered,
            'delivery_rate_7d' => $delivered + $returned > 0 ? round($delivered / ($delivered + $returned), 4) : null,
            'problems' => [
                'total' => (int) ($row->problems ?? 0),
                'delivery_failed' => (int) ($row->p_failed ?? 0),
                'on_hold' => (int) ($row->p_hold ?? 0),
                'returning' => (int) ($row->p_returning ?? 0),
            ],
            'cod_held' => ['total_amount' => array_sum(array_column($byProvider, 'amount')), 'by_provider' => $byProvider],
        ];
    }
}
