<?php

namespace App\Domain\Returns;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentService;
use App\Domain\Returns\Models\ReturnEvent;
use App\Domain\Returns\Models\ReturnItem;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Post-delivery returns and exchanges (P5B-63..P5B-70, §8). Every write locks the order row, then the return row,
 * checks ReturnStateMachine, writes return_events, bumps the return's revision and re-derives orders.return_status.
 * A delivered order stays `delivered` (P5B-68).
 */
class ReturnService
{
    /** The payment link exchange() created for the new order (P5B-67), for the response. */
    public ?PaymentLink $lastLink = null;

    public function __construct(
        private readonly InventoryService $inventory,
        private readonly OrderPlacementService $placement,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array{type: string, reason: string, customer_note?: string|null, lines: list<array{order_item_id: string, quantity: int, exchange_variant_id?: string|null}>}  $input
     */
    public function create(Order $order, array $input, ?User $user): ReturnRequest
    {
        return DB::transaction(function () use ($order, $input, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($o->status !== Order::DELIVERED) {
                throw new ApiException(409, 'return_not_allowed', 'Returns can only be created for delivered orders.');
            }
            $items = OrderItem::query()->where('order_id', $o->id)->get()->keyBy('id');
            $taken = $this->takenQuantities($o->id, null);
            $exchange = $input['type'] === 'exchange';
            if ($exchange && $o->isPos()) {
                // PHASE-8-8D P88D-17 / S205: a till sale has no delivery address; exchange = a return, then a new sale.
                throw ValidationException::withMessages(['type' => ['Till sales are exchanged at the till: return the items, then sell the new ones.']]);
            }

            $errors = [];
            $bounds = [];
            $wanted = [];
            $variants = [];
            if ($exchange) {
                $ids = array_values(array_filter(array_map(fn ($l) => isset($l['exchange_variant_id']) ? strtolower((string) $l['exchange_variant_id']) : null, $input['lines'])));
                $variants = ProductVariant::query()->where('store_id', $o->store_id)->whereIn('id', $ids)->with('product')->get()->keyBy('id');
            }
            foreach ($input['lines'] as $i => $line) {
                $item = $items[strtolower($line['order_item_id'])] ?? null;
                if ($item === null) {
                    $errors["lines.{$i}.order_item_id"] = ['Unknown item.'];

                    continue;
                }
                $wanted[$item->id] = ($wanted[$item->id] ?? 0) + (int) $line['quantity'];
                $left = $item->quantity - ($taken[$item->id] ?? 0);
                if ($wanted[$item->id] > $left) {
                    $bounds["lines.{$i}.quantity"] = [$left > 0 ? "Only {$left} of this item can still be returned." : 'This item has already been returned.'];
                }
                if ($exchange) {
                    $vid = isset($line['exchange_variant_id']) ? strtolower((string) $line['exchange_variant_id']) : null;
                    $variant = $vid !== null ? ($variants[$vid] ?? null) : null;
                    if ($vid === null) {
                        $errors["lines.{$i}.exchange_variant_id"] = ['Choose what the customer wants instead.'];
                    } elseif ($variant === null || $variant->product === null || $variant->product->trashed()) {
                        $errors["lines.{$i}.exchange_variant_id"] = ['Unknown variant.'];
                    } elseif ($variant->product->status === Product::ARCHIVED || ! $variant->is_enabled) {
                        $errors["lines.{$i}.exchange_variant_id"] = ['This variant can’t be sold.'];
                    }
                }
            }
            if ($errors !== []) {
                throw ValidationException::withMessages($errors);
            }
            if ($bounds !== []) {
                throw new ApiException(409, 'return_not_allowed', 'Some quantities are more than can still be returned.', $bounds);
            }

            $sequence = StoreCounter::next($o->store_id, StoreCounter::RETURNS);
            $return = new ReturnRequest;
            $return->store_id = $o->store_id;
            $return->order_id = $o->id;
            $return->sequence = $sequence;
            $return->number = self::number($sequence);
            $return->type = $input['type'];
            $return->status = ReturnRequest::REQUESTED;
            $return->reason = $input['reason'];
            $return->source = 'merchant';
            $return->customer_note = $input['customer_note'] ?? null;
            $return->created_by = $user?->getKey();
            $return->save();

            $requested = 0;
            foreach ($input['lines'] as $line) {
                /** @var OrderItem $item */
                $item = $items[strtolower($line['order_item_id'])];
                $ri = new ReturnItem;
                $ri->store_id = $o->store_id;
                $ri->return_request_id = $return->id;
                $ri->order_item_id = $item->id;
                $ri->quantity = (int) $line['quantity'];
                $ri->amount = self::lineAmount($item, (int) $line['quantity']);
                if ($exchange) {
                    $variant = $variants[strtolower((string) $line['exchange_variant_id'])];
                    $ri->exchange_variant_id = $variant->id;
                    $ri->exchange_variant_title = mb_substr($variant->title, 0, 130);
                }
                $ri->save();
                $requested += $ri->amount;
            }
            $return->requested_amount = $requested;
            $return->save();

            $this->event($return, 'created', $user, $return->customer_note, ['type' => $return->type, 'reason' => $return->reason], null, ReturnRequest::REQUESTED);
            OrderTimeline::record($o, 'return', $user, null, ['action' => 'created', 'return_id' => $return->id, 'number' => $return->number, 'type' => $return->type]);
            $this->syncOrder($o);

            return $return;
        });
    }

    /**
     * 5b-3 seam (§8): a courier `partially_delivered` creates a return in `requested`, source courier, no lines; the
     * merchant adds lines on receive.
     */
    public function createForCourier(Order $order, string $reason = 'refused_at_door'): ReturnRequest
    {
        return DB::transaction(function () use ($order, $reason) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            $sequence = StoreCounter::next($o->store_id, StoreCounter::RETURNS);
            $return = new ReturnRequest;
            $return->store_id = $o->store_id;
            $return->order_id = $o->id;
            $return->sequence = $sequence;
            $return->number = self::number($sequence);
            $return->type = 'return';
            $return->status = ReturnRequest::REQUESTED;
            $return->reason = $reason;
            $return->source = 'courier';
            $return->save();
            $this->event($return, 'created', null, null, ['type' => 'return', 'reason' => $reason, 'source' => 'courier'], null, ReturnRequest::REQUESTED);
            OrderTimeline::record($o, 'return', null, null, ['action' => 'created', 'return_id' => $return->id, 'number' => $return->number, 'type' => 'return']);
            $this->syncOrder($o);

            return $return;
        });
    }

    public function approve(ReturnRequest $return, ?string $tracking, ?string $note, ?User $user): ReturnRequest
    {
        return $this->transition($return, ReturnRequest::APPROVED, $user, $note, function (ReturnRequest $r) use ($tracking) {
            $r->pickup_tracking_code = $tracking;
            $r->approved_at = now();
        }, array_filter(['pickup_tracking_code' => $tracking]));
    }

    public function reject(ReturnRequest $return, string $reason, ?User $user): ReturnRequest
    {
        return $this->transition($return, ReturnRequest::REJECTED, $user, $reason, function (ReturnRequest $r) use ($reason) {
            $r->reject_reason = $reason;
            $r->closed_at = now();
        });
    }

    /** A received return with money refunded closes as `refunded` (P5B-66); otherwise `closed`. */
    public function close(ReturnRequest $return, ?string $note, ?User $user): ReturnRequest
    {
        $to = $return->status === ReturnRequest::RECEIVED && $return->refunded_amount > 0 ? ReturnRequest::REFUNDED : ReturnRequest::CLOSED;

        return $this->transition($return, $to, $user, $note, function (ReturnRequest $r) {
            $r->closed_at = now();
        });
    }

    /**
     * P5B-65: check list + per-line restock (InventoryService::restock, ledger `order_returned`, reference = return).
     *
     * @param  array{checks: array{tags_intact: bool, unused: bool, original_packaging: bool}, lines: list<array{return_item_id?: string|null, order_item_id?: string|null, quantity?: int|null, restock_quantity: int}>}  $input
     */
    public function receive(ReturnRequest $return, array $input, ?User $user): ReturnRequest
    {
        return $this->locked($return, function (Order $o, ReturnRequest $r) use ($input, $user) {
            ReturnStateMachine::assert($r->status, ReturnRequest::RECEIVED);
            $returnItems = ReturnItem::query()->where('return_request_id', $r->id)->get()->keyBy('id');
            $orderItems = OrderItem::query()->where('order_id', $o->id)->get()->keyBy('id');
            $taken = $this->takenQuantities($o->id, $r->id);

            $errors = [];
            $plan = []; // [ReturnItem|null, OrderItem, quantity (new items), restock]
            $seen = [];
            foreach ($input['lines'] as $i => $line) {
                $restock = (int) $line['restock_quantity'];
                if (! empty($line['return_item_id'])) {
                    $ri = $returnItems[strtolower((string) $line['return_item_id'])] ?? null;
                    if ($ri === null || isset($seen[$ri->id])) {
                        $errors["lines.{$i}.return_item_id"] = [$ri === null ? 'Unknown item.' : 'Each item can appear once.'];

                        continue;
                    }
                    $seen[$ri->id] = true;
                    $item = $orderItems[$ri->order_item_id];
                    if ($restock > $ri->quantity - $ri->restocked_quantity) {
                        $errors["lines.{$i}.restock_quantity"] = ['You can put back at most '.($ri->quantity - $ri->restocked_quantity).'.'];
                    }
                    $plan[] = [$ri, $item, $ri->quantity, $restock];
                } elseif (! empty($line['order_item_id']) && $r->source === 'courier') {
                    // Courier-sourced returns get their lines on receive (§8).
                    $item = $orderItems[strtolower((string) $line['order_item_id'])] ?? null;
                    $quantity = (int) ($line['quantity'] ?? 0);
                    if ($item === null || isset($seen[$item->id])) {
                        $errors["lines.{$i}.order_item_id"] = [$item === null ? 'Unknown item.' : 'Each item can appear once.'];

                        continue;
                    }
                    $seen[$item->id] = true;
                    $left = $item->quantity - ($taken[$item->id] ?? 0);
                    if ($quantity < 1 || $quantity > $left) {
                        $errors["lines.{$i}.quantity"] = ["Enter 1 to {$left}."];
                    } elseif ($restock > $quantity) {
                        $errors["lines.{$i}.restock_quantity"] = ["You can put back at most {$quantity}."];
                    }
                    $plan[] = [null, $item, $quantity, $restock];
                } else {
                    $errors["lines.{$i}.return_item_id"] = ['Choose an item of this return.'];
                }
            }
            $perItem = [];
            foreach ($plan as [, $item, , $restock]) {
                $perItem[$item->id] = ($perItem[$item->id] ?? 0) + $restock;
                if ($item->restocked_quantity + $perItem[$item->id] > $item->quantity) {
                    $errors['lines'] = ['Some units were already put back in stock.'];
                }
            }
            if ($r->source === 'courier' && $returnItems->isEmpty() && $plan === []) {
                $errors['lines'] = ['Add the items that came back.'];
            }
            if ($errors !== []) {
                throw ValidationException::withMessages($errors);
            }

            $ledger = [];
            $restocked = [];
            $added = 0;
            foreach ($plan as [$ri, $item, $quantity, $restock]) {
                if ($ri === null) {
                    $ri = new ReturnItem;
                    $ri->store_id = $o->store_id;
                    $ri->return_request_id = $r->id;
                    $ri->order_item_id = $item->id;
                    $ri->quantity = $quantity;
                    $ri->amount = self::lineAmount($item, $quantity);
                    $added += $ri->amount;
                }
                $ri->restocked_quantity += $restock;
                $ri->save();
                if ($restock > 0) {
                    OrderItem::query()->whereKey($item->id)->update(['restocked_quantity' => DB::raw('restocked_quantity + '.$restock), 'updated_at' => now()]);
                    if ($item->tracked && $item->variant_id !== null) {
                        $ledger[] = ['variant_id' => $item->variant_id, 'quantity' => $restock, 'location_id' => $item->location_id];
                    }
                    $restocked[] = ['return_item_id' => $ri->id, 'product_name' => $item->product_name, 'variant_title' => $item->variant_title, 'quantity' => $restock];
                }
            }
            $this->inventory->restock($o->store_id, $ledger, $o->id, $user?->getKey(), 'Return '.$r->number, ['type' => 'return', 'id' => $r->id]);

            $firstReceived = ! ReturnRequest::query()->where('order_id', $o->id)->whereKeyNot($r->id)->whereNotNull('received_at')->exists();
            if ($firstReceived && $o->customer_id !== null) {
                Customer::withTrashed()->whereKey($o->customer_id)->update(['returned_orders_count' => DB::raw('returned_orders_count + 1')]);
            }

            $from = $r->status;
            $r->checks = [
                'tags_intact' => (bool) $input['checks']['tags_intact'],
                'unused' => (bool) $input['checks']['unused'],
                'original_packaging' => (bool) $input['checks']['original_packaging'],
            ];
            $r->requested_amount += $added;
            $r->status = ReturnRequest::RECEIVED;
            $r->received_at = now();
            $r->revision++;
            $r->save();
            $this->event($r, 'status_changed', $user, null, ['checks' => $r->checks], $from, ReturnRequest::RECEIVED);
            WebhookEvents::emit(WebhookEventType::ReturnReceived, $r);
            if ($restocked !== []) {
                $this->event($r, 'restock', $user, null, ['lines' => $restocked, 'units' => array_sum(array_column($restocked, 'quantity'))]);
            }
            OrderTimeline::record($o, 'return', $user, null, ['action' => 'received', 'return_id' => $r->id, 'number' => $r->number, 'restocked_units' => array_sum(array_column($restocked, 'quantity'))]);
            $this->syncOrder($o);

            return $r;
        });
    }

    public function note(ReturnRequest $return, string $body, ?User $user): ReturnEvent
    {
        return $this->event($return, 'note', $user, $body);
    }

    /**
     * Refund linked to a return (P5B-66), called by OrderService::refund INSIDE its transaction after the order row
     * is locked and before the refund row is written: locks the return, checks the amount against what is left on
     * the return. Gateway refunds (5b-2) call the same pair (assert → recorded).
     */
    public function assertRefundable(Order $lockedOrder, string $returnId, int $amount): ReturnRequest
    {
        /** @var ReturnRequest|null $r */
        $r = ReturnRequest::query()->where('order_id', $lockedOrder->id)->whereKey(strtolower($returnId))->lockForUpdate()->first();
        if ($r === null) {
            throw ValidationException::withMessages(['return_id' => ['Unknown return for this order.']]);
        }
        if (! in_array($r->status, [ReturnRequest::APPROVED, ReturnRequest::RECEIVED], true)) {
            throw new ApiException(409, 'invalid_state_transition', 'Only approved or received returns can be refunded.');
        }
        $left = $r->requested_amount - $r->refunded_amount;
        if ($amount > $left) {
            $message = $left > 0 ? 'You can refund at most '.Money::bdt($left).' for this return.' : 'This return has been refunded in full.';
            throw new ApiException(422, 'refund_exceeds_paid', $message, ['amount' => [$message]]);
        }

        return $r;
    }

    /** After the refund row exists: totals, event, and `refunded` when a received return is refunded in full. */
    public function recordRefund(ReturnRequest $r, Payment $refund, ?User $user): void
    {
        $r->refunded_amount += $refund->amount;
        $r->revision++;
        $from = $r->status;
        $full = $r->refunded_amount >= $r->requested_amount;
        if ($full && $r->status === ReturnRequest::RECEIVED) {
            $r->status = ReturnRequest::REFUNDED;
            $r->closed_at = now();
        }
        $r->save();
        $this->event($r, 'refund', $user, $refund->note, ['amount' => $refund->amount, 'method' => $refund->method, 'payment_id' => $refund->id]);
        if ($from !== $r->status) {
            $this->event($r, 'status_changed', $user, null, [], $from, $r->status);
        }
    }

    /**
     * P5B-67: a new manual order with the exchange variants at the current price, an exchange credit = the returned
     * lines' paid value, shipping = zone charge or override, channel = the original's, tag `exchange`.
     *
     * @param  array{shipping_amount_override?: int|null, send_payment_link?: array<string, mixed>|null}  $input
     * @return array{0: ReturnRequest, 1: Order}
     */
    public function exchange(ReturnRequest $return, array $input, ?User $user, ?PermissionSet $permissions, ?string $idempotencyKey): array
    {
        $created = null;
        $link = null;
        $result = $this->locked($return, function (Order $o, ReturnRequest $r) use ($input, $user, $permissions, $idempotencyKey, &$created, &$link) {
            if ($r->type !== 'exchange' || $r->exchange_order_id !== null) {
                throw new ApiException(409, 'invalid_state_transition', 'This return has no exchange to create.');
            }
            ReturnStateMachine::assert($r->status, ReturnRequest::EXCHANGED);
            $items = ReturnItem::query()->where('return_request_id', $r->id)->whereNotNull('exchange_variant_id')->orderBy('id')->get();
            if ($items->isEmpty()) {
                throw new ApiException(409, 'invalid_state_transition', 'This return has no exchange items.');
            }
            $lines = [];
            foreach ($items as $ri) {
                $lines[$ri->exchange_variant_id] = ['variant_id' => $ri->exchange_variant_id, 'quantity' => ($lines[$ri->exchange_variant_id]['quantity'] ?? 0) + $ri->quantity];
            }
            $credit = (int) $items->sum('amount');

            /** @var Store $store */
            $store = Store::query()->findOrFail($o->store_id);
            $order = $this->placement->placeExchange($store, [
                'items' => array_values($lines),
                'channel' => $o->channel,
                'contact' => ['name' => $o->customer_name, 'phone' => $o->customer_phone, 'email' => $o->customer_email],
                'address' => $o->shipping_address,
                'payment_method' => 'cod',
                'shipping_override' => $input['shipping_amount_override'] ?? null,
                'customer_id' => $o->customer_id,
                'credit' => $credit,
                'source_order_id' => $o->id,
                'tags' => ['exchange'],
                'user' => $user,
                'idempotency_key' => $idempotencyKey,
            ]);

            // Price difference = what the new order costs before the credit − the credit (P5B-67).
            $difference = $order->subtotal_amount + $order->shipping_amount - $credit;
            if ($difference < 0 && ! ($permissions?->has(Permission::OrdersRefund) ?? false)) {
                throw new ApiException(403, 'forbidden', 'You do not have permission to create an exchange that needs a refund.');
            }
            // Product decision (2026-11-22): the link charges ONLY the price difference of the goods (exchange items
            // at current price − the returned lines' credit), capped at the due; delivery stays cash on delivery.
            $priceDifference = min($order->subtotal_amount - $credit, $order->dueAmount());
            if (($input['send_payment_link'] ?? null) !== null && $priceDifference > 0) {
                // P5B-67: positive difference → a payment link (custom amount, SMS).
                // Resolved lazily: PaymentLinkService → PaymentService → OrderService → this service.
                $provider = (string) $input['send_payment_link']['provider'];
                if (PaymentService::usableProviders($o->store_id) === [] || ! in_array($provider, PaymentService::usableProviders($o->store_id), true)) {
                    throw new ApiException(422, 'gateway_not_connected', 'Connect and turn on this payment method to send a payment link.', [
                        'send_payment_link.provider' => ['This payment method isn’t connected.'],
                    ]);
                }
                $link = app(PaymentLinkService::class)->create($order, [
                    'amount_kind' => 'custom',
                    'amount' => $priceDifference,
                    'provider' => $provider,
                    'expires_in_minutes' => (int) $input['send_payment_link']['expires_in_minutes'],
                    'cancel_if_unpaid' => false,
                    'send_sms' => true,
                ], $user);
            }

            $from = $r->status;
            $r->exchange_order_id = $order->id;
            $r->status = ReturnRequest::EXCHANGED;
            $r->closed_at = now();
            $r->revision++;
            $r->save();
            $this->event($r, 'status_changed', $user, null, ['exchange_order_id' => $order->id, 'exchange_order_number' => $order->number, 'price_difference_amount' => $difference], $from, ReturnRequest::EXCHANGED);
            OrderTimeline::record($o, 'return', $user, null, ['action' => 'exchanged', 'return_id' => $r->id, 'number' => $r->number, 'exchange_order_id' => $order->id, 'exchange_order_number' => $order->number]);
            $this->audit->log('return.exchange_created', $o, ['return_id' => $r->id, 'exchange_order_id' => $order->id, 'difference' => $difference], $user);
            $this->syncOrder($o);
            $created = $order;

            return $r;
        });
        $this->placement->notifyPlaced($created, null);
        $this->lastLink = $link;

        return [$result, $created];
    }

    /** orders.return_status from its returns (P5B-68). Caller holds the order row lock. */
    public function syncOrder(Order $o): void
    {
        $returns = ReturnRequest::query()->where('order_id', $o->id)->where('status', '<>', ReturnRequest::REJECTED)->get(['id', 'status', 'received_at']);
        $received = $returns->filter(fn (ReturnRequest $r) => $r->received_at !== null)->pluck('id')->all();
        $units = $received === [] ? 0 : (int) ReturnItem::query()->whereIn('return_request_id', $received)->sum('quantity');
        $total = (int) OrderItem::query()->where('order_id', $o->id)->sum('quantity');
        $status = match (true) {
            $units > 0 && $units >= $total => 'returned',
            $units > 0 => 'partially_returned',
            $returns->contains(fn (ReturnRequest $r) => in_array($r->status, [ReturnRequest::REQUESTED, ReturnRequest::APPROVED], true)) => 'requested',
            default => 'none',
        };
        if ($o->return_status !== $status) {
            $o->return_status = $status;
            $o->revision++;
            $o->save();
        }
    }

    public static function number(int $sequence): string
    {
        return 'RT-'.str_pad((string) $sequence, 4, '0', STR_PAD_LEFT);
    }

    /** §8: floor(line total × returned quantity / line quantity). */
    public static function lineAmount(OrderItem $item, int $quantity): int
    {
        return $item->quantity > 0 ? intdiv($item->total_amount * $quantity, $item->quantity) : 0;
    }

    /**
     * Units of each order item already in other non-rejected returns.
     *
     * @return array<string, int>
     */
    private function takenQuantities(string $orderId, ?string $exceptReturnId): array
    {
        $rows = DB::table('return_items')
            ->join('return_requests', 'return_requests.id', '=', 'return_items.return_request_id')
            ->where('return_requests.order_id', $orderId)
            ->where('return_requests.status', '<>', ReturnRequest::REJECTED)
            ->when($exceptReturnId !== null, fn ($q) => $q->where('return_requests.id', '<>', $exceptReturnId))
            ->groupBy('return_items.order_item_id')
            ->selectRaw('return_items.order_item_id as id, sum(return_items.quantity) as qty')
            ->get();
        $out = [];
        foreach ($rows as $row) {
            $out[$row->id] = (int) $row->qty;
        }

        return $out;
    }

    /**
     * @param  callable(ReturnRequest): void|null  $effects
     * @param  array<string, mixed>  $meta
     */
    private function transition(ReturnRequest $return, string $to, ?User $user, ?string $body, ?callable $effects = null, array $meta = []): ReturnRequest
    {
        return $this->locked($return, function (Order $o, ReturnRequest $r) use ($to, $user, $body, $effects, $meta) {
            ReturnStateMachine::assert($r->status, $to);
            $from = $r->status;
            if ($effects !== null) {
                $effects($r);
            }
            $r->status = $to;
            $r->revision++;
            $r->save();
            $this->event($r, 'status_changed', $user, $body, $meta, $from, $to);
            $this->syncOrder($o);

            return $r;
        });
    }

    /**
     * Lock order (the order row, then the return row).
     *
     * @template T
     *
     * @param  callable(Order, ReturnRequest): T  $fn
     * @return T
     */
    private function locked(ReturnRequest $return, callable $fn): mixed
    {
        return DB::transaction(function () use ($return, $fn) {
            /** @var Order $o */
            $o = Order::query()->whereKey($return->order_id)->lockForUpdate()->firstOrFail();
            /** @var ReturnRequest $r */
            $r = ReturnRequest::query()->whereKey($return->id)->lockForUpdate()->firstOrFail();

            return $fn($o, $r);
        });
    }

    /** @param array<string, mixed> $meta */
    private function event(ReturnRequest $r, string $type, ?User $user, ?string $body = null, array $meta = [], ?string $from = null, ?string $to = null): ReturnEvent
    {
        $event = new ReturnEvent;
        $event->store_id = $r->store_id;
        $event->return_request_id = $r->id;
        $event->type = $type;
        $event->from_status = $from;
        $event->to_status = $to;
        $event->actor_type = $user !== null ? 'user' : 'system';
        $event->actor_user_id = $user?->getKey();
        $event->body = $body;
        $event->meta = $meta;
        $event->created_at = now();
        $event->save();

        return $event;
    }
}
