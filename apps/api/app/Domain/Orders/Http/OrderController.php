<?php

namespace App\Domain\Orders\Http;

use App\Domain\Catalog\Support\StockSql;
use App\Domain\Geo\AddressValidator;
use App\Domain\Geo\BdGeo;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Orders\OrderService;
use App\Domain\Payments\PaymentService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

/** §3.7 merchant orders. O A S operate; cancelling a paid order and refunds need ManageRefunds (O A). */
class OrderController
{
    public function __construct(
        private readonly OrderService $orders,
        private readonly OrderPlacementService $placement,
        private readonly AddressValidator $addresses,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $list = fn (array $values) => 'regex:/^('.implode('|', $values).')(,('.implode('|', $values).'))*$/';
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,payment_status,channel,district_code,customer_id,coupon_id,placed_at,printed,not_printed,has_shipment'],
            'filter.has_shipment' => ['sometimes', 'string', 'in:0,1'],
            'filter.printed' => ['sometimes', 'string', 'in:invoice,label'],
            'filter.not_printed' => ['sometimes', 'string', 'in:invoice,label'],
            'filter.status' => ['sometimes', 'string', $list(Order::STATUSES)],
            'filter.payment_status' => ['sometimes', 'string', $list(Order::PAYMENT_STATUSES)],
            'filter.channel' => ['sometimes', 'string', $list(Order::CHANNELS)],
            'filter.district_code' => ['sometimes', 'string', 'max:32'],
            'filter.customer_id' => ['sometimes', 'string', 'max:26'],
            'filter.coupon_id' => ['sometimes', 'string', 'max:26'],
            'filter.placed_at' => ['sometimes', 'array:gte,lte'],
            'filter.placed_at.gte' => ['sometimes', 'date'],
            'filter.placed_at.lte' => ['sometimes', 'date'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:-placed_at,placed_at,-total'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = $input['filter'] ?? [];
        $q = trim((string) ($input['q'] ?? ''));

        $query = self::filtered($store, $filter, $q, withStatus: true);
        // 5b-4 (Invoices & labels page): "Printed today" (store time) / "Not printed".
        if (isset($filter['printed'])) {
            $tz = $store->timezone ?: 'Asia/Dhaka';
            $query->where($filter['printed'].'_printed_at', '>=', Carbon::now($tz)->startOfDay()->utc());
        }
        if (isset($filter['not_printed'])) {
            $query->whereNull($filter['not_printed'].'_printed_at');
        }
        // 5b-3: orders with (1) / without (0) an active shipment (not cancelled / booking_failed).
        if (isset($filter['has_shipment'])) {
            $active = fn ($q) => $q->selectRaw('1')->from('shipments')->whereColumn('shipments.order_id', 'orders.id')
                ->whereNotIn('shipments.status', ['cancelled', 'booking_failed']);
            $filter['has_shipment'] === '1' ? $query->whereExists($active) : $query->whereNotExists($active);
        }
        match ($input['sort'] ?? '-placed_at') {
            'placed_at' => $query->orderBy('placed_at')->orderBy('id'),
            '-total' => $query->orderByDesc('total_amount')->orderByDesc('id'),
            default => $query->orderByDesc('placed_at')->orderByDesc('id'),
        };
        $page = $query->with(['customer', 'shipment'])->withSum('items', 'quantity')->paginate((int) ($input['per_page'] ?? 25));

        $byStatus = self::filtered($store, $filter, $q, withStatus: false)->toBase()->reorder()
            ->groupBy('status')->selectRaw('status, count(*) as aggregate')->pluck('aggregate', 'status');
        $counts = ['all' => (int) $byStatus->sum()];
        foreach (Order::STATUSES as $status) {
            $counts[$status] = (int) ($byStatus[$status] ?? 0);
        }

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (Order $o) => OrderPresenter::summary($o))->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $counts,
            ],
        ]);
    }

    /** @param array<string, mixed> $filter */
    public static function filtered(Store $store, array $filter, string $q, bool $withStatus): Builder
    {
        $query = Order::query()->where('orders.store_id', $store->id);
        if ($withStatus && isset($filter['status'])) {
            $query->whereIn('status', explode(',', $filter['status']));
        }
        foreach (['payment_status', 'channel'] as $key) {
            if (isset($filter[$key])) {
                $query->whereIn($key, explode(',', $filter[$key]));
            }
        }
        foreach (['district_code', 'customer_id', 'coupon_id'] as $key) {
            if (isset($filter[$key]) && $filter[$key] !== '') {
                $query->where($key, strtolower($filter[$key]));
            }
        }
        if (isset($filter['placed_at']['gte'])) {
            $query->where('placed_at', '>=', Carbon::parse($filter['placed_at']['gte'])->utc());
        }
        if (isset($filter['placed_at']['lte'])) {
            $query->where('placed_at', '<=', Carbon::parse($filter['placed_at']['lte'])->utc());
        }
        if ($q !== '') {
            $digits = ltrim(Phone::clean($q), '+');
            $query->where(function (Builder $w) use ($q, $digits) {
                $upper = strtoupper($q);
                $w->where('number', 'like', addcslashes($upper, '%_\\').'%');
                if (ctype_digit($digits)) {
                    $w->orWhere('sequence', (int) $digits);
                    if (strlen($digits) >= 4) {
                        $phone = str_starts_with($digits, '01') ? '88'.$digits.'%' : (str_starts_with($digits, '8801') ? $digits.'%' : '%'.$digits.'%');
                        $w->orWhere('customer_phone', 'like', $phone);
                    }
                } else {
                    $w->orWhere('customer_name', StockSql::like(), StockSql::contains($q));
                }
            });
        }

        return $query;
    }

    public function quote(Request $request, Store $store, BdGeo $geo): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'items' => ['sometimes', 'array', 'max:'.Order::MAX_ITEMS],
            'items.*.variant_id' => ['required', 'string', 'max:26'],
            'items.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:99'],
            'contact' => ['sometimes', 'array'],
            'contact.phone' => ['sometimes', 'nullable', 'string', 'max:20'],
            'shipping_address' => ['sometimes', 'nullable', 'array'],
            'shipping_address.district_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'shipping_address.thana_code' => ['sometimes', 'nullable', 'string', 'max:48'],
            'coupon_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'shipping_amount_override' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000'],
            'channel' => ['sometimes', 'nullable', 'string'],
        ]);
        $district = $input['shipping_address']['district_code'] ?? null;
        $thana = $input['shipping_address']['thana_code'] ?? null;
        $address = $district !== null && $thana !== null && $geo->thanaInDistrict($district, $thana)
            ? ['district_code' => $district, 'thana_code' => $thana] : null;

        return new JsonResponse(['data' => $this->placement->quote($store, [
            'items' => $input['items'] ?? [],
            'contact' => ['phone' => Phone::bdMsisdn($input['contact']['phone'] ?? null)],
            'address' => $address,
            'coupon_code' => $input['coupon_code'] ?? null,
            'shipping_override' => $input['shipping_amount_override'] ?? null,
        ])]);
    }

    public function store(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $channels = array_values(array_diff(Order::CHANNELS, ['website']));
        $input = $request->validate([
            'items' => ['required', 'array', 'min:1', 'max:'.Order::MAX_ITEMS],
            'items.*' => ['array:variant_id,quantity'],
            'items.*.variant_id' => ['required', 'string', 'max:26', 'distinct:ignore_case'],
            'items.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:99'],
            'channel' => ['required', 'string', Rule::in($channels)],
            ...self::contactRules(),
            ...AddressValidator::rules('shipping_address'),
            'payment_method' => ['sometimes', 'string'],
            'coupon_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'shipping_amount_override' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000'],
            'customer_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'customer_note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'accepts_marketing' => ['sometimes', 'boolean'],
            'notify_customer' => ['sometimes', 'boolean'],
        ], ['items.*.variant_id.distinct' => 'Each variant can appear once.']);

        $order = $this->placement->manual($store, [
            'items' => $input['items'],
            'channel' => $input['channel'],
            'contact' => self::contact($input['contact']),
            'address' => $this->addresses->snapshot($input['shipping_address']),
            'payment_method' => $input['payment_method'] ?? 'cod',
            'coupon_code' => $input['coupon_code'] ?? null,
            'shipping_override' => $input['shipping_amount_override'] ?? null,
            'customer_id' => $input['customer_id'] ?? null,
            'customer_note' => AddressValidator::clean($input['customer_note'] ?? null),
            'accepts_marketing' => (bool) ($input['accepts_marketing'] ?? false),
            'notify' => array_key_exists('notify_customer', $input) ? (bool) $input['notify_customer'] : true,
            'user' => $request->user(),
            'idempotency_key' => $request->header(IdempotencyGuard::HEADER),
            'ip' => $request->ip(),
            'user_agent' => $request->userAgent(),
        ]);

        return $this->one($order, 201);
    }

    public function show(Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->one($order);
    }

    public function update(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'revision' => ['required', 'integer:strict'],
            'contact' => ['sometimes', 'array:name,phone,email'],
            'contact.name' => ['sometimes', 'string', 'min:2', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'contact.phone' => ['sometimes', 'string', PhoneRule::bdMobile()],
            'contact.email' => ['sometimes', 'nullable', 'string', 'email:rfc', 'max:254'],
            ...AddressValidator::rules('shipping_address', required: false),
            'customer_note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'tags' => ['sometimes', 'array', 'max:20'],
            'tags.*' => ['string', 'max:40'],
        ]);
        [$order, $hint] = $this->orders->update($order, $input, $request->user());

        return $this->one($order, 200, ['shipping_hint' => $hint]);
    }

    public function confirm(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['notify_customer' => ['sometimes', 'boolean']]);

        return $this->one($this->orders->confirm($order, $request->user(), $input['notify_customer'] ?? null));
    }

    public function ready(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->one($this->orders->ready($order, $request->user()));
    }

    public function ship(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'carrier_name' => ['sometimes', 'nullable', 'string', 'max:60'],
            'tracking_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'tracking_url' => ['sometimes', 'nullable', 'string', 'max:500', 'url:https', 'starts_with:https://'],
            'notify_customer' => ['sometimes', 'boolean'],
        ], ['tracking_url.url' => 'Enter a secure link (https://…).', 'tracking_url.starts_with' => 'Enter a secure link (https://…).']);
        $clean = array_map(fn ($v) => is_string($v) ? AddressValidator::clean($v) : $v, array_intersect_key($input, array_flip(['carrier_name', 'tracking_code', 'tracking_url'])));

        return $this->one($this->orders->ship($order, $clean, $request->user(), $input['notify_customer'] ?? null));
    }

    public function deliver(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->one($this->orders->deliver($order, $request->user()));
    }

    public function return(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'restock' => ['present', 'array', 'max:'.Order::MAX_ITEMS],
            'restock.*.item_id' => ['required', 'string', 'max:26'],
            'restock.*.quantity' => ['required', 'integer:strict', 'min:0', 'max:99'],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        return $this->one($this->orders->return($order, $input['restock'], AddressValidator::clean($input['note'] ?? null), $request->user()));
    }

    public function cancel(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'reason' => ['required', 'string', Rule::in(Order::CANCEL_REASONS)],
            'note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'notify_customer' => ['sometimes', 'boolean'],
            'refund_to_gateway' => ['sometimes', 'boolean'],
        ]);
        $order = $this->orders->cancel($order, $input['reason'], AddressValidator::clean($input['note'] ?? null), $input['notify_customer'] ?? null, $request->user(), $this->context->role());
        // P5B-25: the cancel commits first; then the online payments go back through their gateway (default on).
        if (($input['refund_to_gateway'] ?? true) && $order->paid_amount - $order->refunded_amount > 0) {
            app(PaymentService::class)->refundCancelledOrder($order, $request->user());
            $order->refresh();
        }

        return $this->one($order);
    }

    public function bulk(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'action' => ['required', 'string', 'in:confirm,ready'],
            'ids' => ['required', 'array', 'min:1', 'max:100'],
            'ids.*' => ['required', 'string', 'distinct'],
        ]);
        $ids = array_map('strtolower', $input['ids']);
        $known = Order::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('id')->flip();
        $errors = [];
        foreach ($ids as $i => $id) {
            if (! isset($known[$id])) {
                $errors["ids.{$i}"] = ['Unknown order.'];
            }
        }
        if ($errors !== []) {
            throw new ApiException(422, 'validation_failed', 'The given data was invalid.', $errors);
        }

        return new JsonResponse(['data' => $this->orders->bulk($store, $input['action'], $ids, $request->user())]);
    }

    public function addNote(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate(['body' => ['required', 'string', 'min:1', 'max:1000', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u']]);
        $event = $this->orders->note($order, $input['body'], $request->user());

        return new JsonResponse(['data' => OrderPresenter::event($event->load('actor'))], 201);
    }

    public function refund(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        if (! Permission::ManageRefunds->grantedTo($this->context->role())) {
            throw new ApiException(403, 'forbidden', 'Only owners and managers can record refunds.');
        }
        $input = $request->validate([
            'amount' => ['required', 'integer:strict', 'min:1', 'max:1000000000000'],
            'method' => ['required', 'string', Rule::in([...Payment::REFUND_METHODS, Payment::METHOD_GATEWAY])],
            'reference' => ['sometimes', 'nullable', 'string', 'max:64'],
            'note' => ['sometimes', 'nullable', 'string', 'max:255'],
            'return_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'payment_id' => ['required_if:method,gateway', 'nullable', 'string', 'max:26'],
        ]);
        $input['reference'] = AddressValidator::clean($input['reference'] ?? null);
        $input['note'] = AddressValidator::clean($input['note'] ?? null);
        $payment = $input['method'] === Payment::METHOD_GATEWAY
            ? app(PaymentService::class)->refund($order, $input, $request->header(IdempotencyGuard::HEADER), $request->user())
            : $this->orders->refund($order, $input, $request->header(IdempotencyGuard::HEADER), $request->user());

        return new JsonResponse(['data' => OrderPresenter::payment($payment->load('actor'), $this->context->role())], 201);
    }

    /** @return array<string, list<mixed>> */
    public static function contactRules(): array
    {
        return [
            'contact' => ['required', 'array:name,phone,email'],
            'contact.name' => ['required', 'string', 'min:2', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'contact.phone' => ['required', 'string', PhoneRule::bdMobile()],
            'contact.email' => ['sometimes', 'nullable', 'string', 'email:rfc', 'max:254'],
        ];
    }

    /** @param array<string, mixed> $contact @return array{name: string, phone: string, email: string|null} */
    public static function contact(array $contact): array
    {
        $email = isset($contact['email']) && is_string($contact['email']) && trim($contact['email']) !== '' ? strtolower(trim($contact['email'])) : null;

        return [
            'name' => (string) AddressValidator::clean($contact['name']),
            'phone' => (string) Phone::bdMsisdn($contact['phone']),
            'email' => $email,
        ];
    }

    /** @param array<string, mixed>|null $meta */
    private function one(Order $order, int $status = 200, ?array $meta = null): JsonResponse
    {
        $order = Order::query()->whereKey($order->id)->firstOrFail();
        $body = ['data' => OrderPresenter::full($order, $this->context->role())];
        if ($meta !== null) {
            $body['meta'] = $meta;
        }

        return new JsonResponse($body, $status);
    }
}
