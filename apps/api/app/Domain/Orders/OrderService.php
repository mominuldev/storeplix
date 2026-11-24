<?php

namespace App\Domain\Orders;

use App\Domain\Automations\Engine\AutomationTriggers;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Geo\AddressValidator;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Returns\ReturnService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Order lifecycle after placement (P5-17..P5-22, §3.7). Every transition locks the order row, checks the state
 * machine, applies its side effects (stock through InventoryService, coupon, payments, customer counters), stamps the
 * *_at column, writes a `status_changed` event, bumps `revision`, and queues notifications after commit.
 * Lock order (§7): order → inventories (variant_id) → coupon.
 */
class OrderService
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly OrderNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly AddressValidator $addresses,
        private readonly ZoneResolver $zones,
        private readonly ReturnService $returns,
    ) {}

    public function confirm(Order $order, ?User $user, ?bool $notify = null): Order
    {
        $from = null;
        $order = $this->transition($order, Order::CONFIRMED, $user, function (Order $o) use (&$from) {
            $from = $o->status;
            if ($from === Order::PENDING_PAYMENT) {
                // P5B-14: only a verified payment confirms an unpaid online order (PaymentService, actor system).
                throw new ApiException(409, 'invalid_state_transition', 'This order is waiting for the online payment. It confirms itself once the payment is verified.');
            }
            $o->confirmed_at ??= now();
        });
        if ($from === Order::PENDING) {
            $this->notifier->sms($order, 'order_confirmed', $notify);
        }

        return $order;
    }

    public function ready(Order $order, ?User $user): Order
    {
        return $this->transition($order, Order::READY_TO_SHIP, $user);
    }

    /** @param array{carrier_name?: string|null, tracking_code?: string|null, tracking_url?: string|null} $input */
    public function ship(Order $order, array $input, ?User $user, ?bool $notify = null): Order
    {
        $carrier = $input['carrier_name'] ?? null;
        $order = $this->transition($order, Order::SHIPPED, $user, function (Order $o) use ($input, $user) {
            OrderItemEditor::assertNotBooked($o); // 5b-3: a booked courier parcel ships through courier events
            $now = now();
            $shipment = new Shipment;
            $shipment->store_id = $o->store_id;
            $shipment->order_id = $o->id;
            $shipment->provider = 'manual';
            $shipment->carrier_name = $input['carrier_name'] ?? null;
            $shipment->tracking_code = $input['tracking_code'] ?? null;
            $shipment->tracking_url = $input['tracking_url'] ?? null;
            $shipment->status = 'shipped';
            $shipment->cod_amount = $o->dueAmount();
            $shipment->shipped_at = $now;
            $shipment->created_by = $user?->getKey();
            $shipment->save();
            WebhookEvents::shipment($shipment);

            $lines = [];
            foreach (OrderItem::query()->where('order_id', $o->id)->orderBy('position')->get() as $i => $item) {
                if ($item->tracked && $item->variant_id !== null) {
                    $lines[] = ['variant_id' => $item->variant_id, 'quantity' => $item->quantity, 'field' => "items.{$i}.quantity", 'location_id' => $item->location_id];
                }
            }
            $this->inventory->ship($o->store_id, $lines, $o->id, $user?->getKey());
            $o->shipped_at = $now;
        }, meta: array_filter([
            'carrier_name' => $input['carrier_name'] ?? null,
            'tracking_code' => $input['tracking_code'] ?? null,
            'tracking_url' => $input['tracking_url'] ?? null,
        ]));
        $this->notifier->sms($order, 'order_shipped', $notify, $carrier);

        return $order;
    }

    public function deliver(Order $order, ?User $user): Order
    {
        return $this->transition($order, Order::DELIVERED, $user, function (Order $o) {
            $now = now();
            Payment::query()->where('order_id', $o->id)->where('provider', 'cod')->where('type', 'charge')->where('status', 'pending')
                ->update(['status' => 'succeeded', 'verified_at' => $now, 'updated_at' => $now]);
            if ($o->total_amount > 0) {
                $o->paid_amount = $o->total_amount;
                $o->payment_status = $o->refunded_amount > 0 ? 'partially_refunded' : 'paid';
                WebhookEvents::orderPaidIfChanged($o);
            }
            Shipment::query()->where('order_id', $o->id)->where('status', 'shipped')->get()->each(fn (Shipment $sh) => WebhookEvents::shipment($sh, 'delivered'));
            Shipment::query()->where('order_id', $o->id)->where('status', 'shipped')->update(['status' => 'delivered', 'delivered_at' => $now, 'updated_at' => $now]);
            $o->delivered_at = $now;
            if ($o->customer_id !== null) {
                Customer::withTrashed()->whereKey($o->customer_id)->update([
                    'delivered_orders_count' => DB::raw('delivered_orders_count + 1'),
                    'total_spent_amount' => DB::raw('total_spent_amount + '.(int) $o->total_amount),
                ]);
            }
        });
    }

    /** @param list<array{item_id: string, quantity: int}> $restock */
    public function return(Order $order, array $restock, ?string $note, ?User $user): Order
    {
        return $this->transition($order, Order::RETURNED, $user, function (Order $o) use ($restock, $note, $user) {
            $items = OrderItem::query()->where('order_id', $o->id)->get()->keyBy('id');
            $errors = [];
            $wanted = [];
            foreach ($restock as $i => $line) {
                $item = $items[strtolower($line['item_id'])] ?? null;
                if ($item === null) {
                    $errors["restock.{$i}.item_id"] = ['Unknown item.'];

                    continue;
                }
                $quantity = (int) $line['quantity'];
                $max = $item->quantity - $item->restocked_quantity - ($wanted[$item->id] ?? 0);
                if ($quantity > $max) {
                    $errors["restock.{$i}.quantity"] = ["You can restock at most {$max}."];

                    continue;
                }
                $wanted[$item->id] = ($wanted[$item->id] ?? 0) + $quantity;
            }
            if ($errors !== []) {
                throw ValidationException::withMessages($errors);
            }
            $lines = [];
            foreach ($wanted as $itemId => $quantity) {
                $item = $items[$itemId];
                if ($quantity <= 0) {
                    continue;
                }
                OrderItem::query()->whereKey($itemId)->update(['restocked_quantity' => $item->restocked_quantity + $quantity, 'updated_at' => now()]);
                if ($item->tracked && $item->variant_id !== null) {
                    $lines[] = ['variant_id' => $item->variant_id, 'quantity' => $quantity, 'location_id' => $item->location_id];
                }
            }
            $this->inventory->restock($o->store_id, $lines, $o->id, $user?->getKey(), $note !== null ? mb_substr($note, 0, 255) : null);

            $now = now();
            Payment::query()->where('order_id', $o->id)->where('provider', 'cod')->where('type', 'charge')->where('status', 'pending')
                ->update(['status' => 'cancelled', 'updated_at' => $now]);
            Shipment::query()->where('order_id', $o->id)->where('status', 'shipped')->get()->each(fn (Shipment $sh) => WebhookEvents::shipment($sh, 'returned'));
            Shipment::query()->where('order_id', $o->id)->where('status', 'shipped')->update(['status' => 'returned', 'returned_at' => $now, 'updated_at' => $now]);
            $o->returned_at = $now;
            if ($o->customer_id !== null) {
                Customer::withTrashed()->whereKey($o->customer_id)->update(['returned_orders_count' => DB::raw('returned_orders_count + 1')]);
            }
            app(FraudGuard::class)->afterReturned($o); // PHASE-8-8 P88-10 repeat returners (after commit)
        }, $note);
    }

    /**
     * P5B-69: restock a courier-returned order (`returned`, no automatic restock), cumulative up to the shipped
     * quantity. Ledger `order_returned`; one `return` event (action restock); revision++.
     *
     * @param  list<array{item_id: string, quantity: int}>  $lines
     */
    public function restock(Order $order, array $lines, ?string $note, ?User $user): Order
    {
        return DB::transaction(function () use ($order, $lines, $note, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($o->status !== Order::RETURNED) {
                throw new ApiException(409, 'invalid_state_transition', 'Only returned orders can be restocked here.');
            }
            $items = OrderItem::query()->where('order_id', $o->id)->get()->keyBy('id');
            $errors = [];
            $wanted = [];
            foreach ($lines as $i => $line) {
                $item = $items[strtolower($line['item_id'])] ?? null;
                if ($item === null) {
                    $errors["lines.{$i}.item_id"] = ['Unknown item.'];

                    continue;
                }
                $max = $item->quantity - $item->restocked_quantity - ($wanted[$item->id] ?? 0);
                if ((int) $line['quantity'] > $max) {
                    $errors["lines.{$i}.quantity"] = [$max > 0 ? "You can restock at most {$max}." : 'Everything was already restocked.'];

                    continue;
                }
                $wanted[$item->id] = ($wanted[$item->id] ?? 0) + (int) $line['quantity'];
            }
            if ($errors !== []) {
                throw ValidationException::withMessages($errors);
            }
            $ledger = [];
            $meta = [];
            foreach ($wanted as $itemId => $quantity) {
                $item = $items[$itemId];
                OrderItem::query()->whereKey($itemId)->update(['restocked_quantity' => $item->restocked_quantity + $quantity, 'updated_at' => now()]);
                if ($item->tracked && $item->variant_id !== null) {
                    $ledger[] = ['variant_id' => $item->variant_id, 'quantity' => $quantity, 'location_id' => $item->location_id];
                }
                $meta[] = ['item_id' => $itemId, 'product_name' => $item->product_name, 'variant_title' => $item->variant_title, 'quantity' => $quantity];
            }
            $this->inventory->restock($o->store_id, $ledger, $o->id, $user?->getKey(), $note !== null ? mb_substr($note, 0, 255) : null);
            $o->revision++;
            $o->save();
            OrderTimeline::record($o, 'return', $user, $note, ['action' => 'restock', 'lines' => $meta, 'units' => array_sum(array_column($meta, 'quantity'))]);

            return $o;
        });
    }

    public function cancel(Order $order, string $reason, ?string $note, ?bool $notify, ?User $user, ?PermissionSet $permissions): Order
    {
        $paid = false;
        $order = $this->transition($order, Order::CANCELLED, $user, function (Order $o) use ($reason, $permissions, $user, &$paid) {
            $paid = $o->paid_amount > 0;
            if ($paid && ! ($permissions?->has(Permission::OrdersRefund) ?? false)) {
                throw new ApiException(403, 'forbidden', 'You do not have permission to cancel paid orders.');
            }
            $this->cancelEffects($o, $reason, $user);
        }, $note, ['reason' => $reason]);

        if ($paid) {
            $this->audit->log('order.cancelled', $order, ['reason' => $reason], $user);
        }
        $this->notifier->sms($order, 'order_cancelled', $notify);

        return $order;
    }

    /**
     * System cancel for an unpaid hold or an unpaid payment link (P5B-21 `payment_timeout`, P5B-22
     * `payment_link_expired`): actor system, no role check, no SMS. `$guard` runs under the order row lock (lock order
     * order → payments → …) and decides: false = leave the order as it is (its own writes still commit). Returns the
     * cancelled order, or null when the guard declined.
     *
     * @param  callable(Order): bool  $guard
     */
    public function systemCancel(Order $order, string $reason, callable $guard): ?Order
    {
        return DB::transaction(function () use ($order, $reason, $guard) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if (! $guard($o) || ! OrderStateMachine::can($o->status, Order::CANCELLED) || $o->paid_amount > 0) {
                return null;
            }
            $from = $o->status;
            $this->cancelEffects($o, $reason, null);
            $o->status = Order::CANCELLED;
            $o->revision++;
            $o->save();
            OrderTimeline::record($o, 'status_changed', null, null, ['reason' => $reason], $from, Order::CANCELLED);
            WebhookEvents::orderStatus($o, Order::CANCELLED);
            AutomationTriggers::unfinishedOrder($o, $reason); // PHASE-8-6 P86-13: payment_timeout → checkout.abandoned (after commit)

            return $o;
        });
    }

    /** Cancel side effects under the order lock: stock, coupon, open charges and links, customer counter. */
    private function cancelEffects(Order $o, string $reason, ?User $user): void
    {
        $lines = [];
        foreach (OrderItem::query()->where('order_id', $o->id)->get() as $item) {
            if ($item->tracked && $item->variant_id !== null) {
                $lines[] = ['variant_id' => $item->variant_id, 'quantity' => $item->quantity, 'location_id' => $item->location_id];
            }
        }
        $this->inventory->release($o->store_id, $lines);

        $redemption = CouponRedemption::query()->where('order_id', $o->id)->where('status', CouponRedemption::ACTIVE)->first();
        if ($redemption !== null) {
            Coupon::query()->whereKey($redemption->coupon_id)->lockForUpdate()->first();
            $redemption->status = CouponRedemption::RELEASED;
            $redemption->save();
            Coupon::query()->whereKey($redemption->coupon_id)->where('used_count', '>', 0)->update(['used_count' => DB::raw('used_count - 1')]);
            OrderTimeline::record($o, 'coupon_released', $user, null, ['code' => $o->coupon_code]);
        }

        $now = now();
        Payment::query()->where('order_id', $o->id)->where('provider', 'cod')->where('type', 'charge')->where('status', 'pending')
            ->update(['status' => 'cancelled', 'updated_at' => $now]);
        // 5b-2: an open online attempt and an active payment link die with the order (a late payment is refunded).
        Payment::query()->where('order_id', $o->id)->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('type', 'charge')->where('status', 'pending')
            ->update(['status' => 'cancelled', 'failure_code' => $reason === 'payment_timeout' ? 'expired' : 'order_cancelled', 'updated_at' => $now]);
        PaymentLink::query()->where('order_id', $o->id)->where('status', PaymentLink::ACTIVE)
            ->update(['status' => PaymentLink::CANCELLED, 'cancelled_at' => $now, 'updated_at' => $now]);
        if ($o->customer_id !== null) {
            Customer::withTrashed()->whereKey($o->customer_id)->where('orders_count', '>', 0)->update(['orders_count' => DB::raw('orders_count - 1')]);
        }
        $o->cancel_reason = $reason;
        $o->cancelled_at = $now;
        // PHASE-8-8 §5.3: a cancelled order is no longer held.
        $o->guard_hold = null;
        $o->guard_hold_at = null;
    }

    /**
     * Manual refund record (P5-18). Amount ≤ paid − refunded. Idempotency-Key handled by the route middleware; the
     * payments unique key is the final guard.
     *
     * 5b-5: `return_id` links the refund to a return of this order (P5B-66): bounded by what is left on the return,
     * and the return moves to `refunded` when a received return is refunded in full. Gateway refunds (5b-2, method
     * `gateway`) plug in here: same order lock, same ReturnService assert → record pair.
     *
     * @param  array{amount: int, method: string, reference?: string|null, note?: string|null, return_id?: string|null}  $input
     */
    public function refund(Order $order, array $input, ?string $idempotencyKey, ?User $user): Payment
    {
        $payment = DB::transaction(function () use ($order, $input, $idempotencyKey, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            $refundable = $o->paid_amount - $o->refunded_amount;
            if ($input['amount'] > $refundable) {
                $message = $refundable > 0
                    ? 'You can refund at most '.Money::bdt($refundable).'.'
                    : 'Nothing has been paid on this order yet.';
                throw new ApiException(422, 'refund_exceeds_paid', $message, ['amount' => [$message]]);
            }
            $return = ($input['return_id'] ?? null) !== null ? $this->returns->assertRefundable($o, (string) $input['return_id'], (int) $input['amount']) : null;
            $charge = Payment::query()->where('order_id', $o->id)->where('type', 'charge')->where('status', 'succeeded')->orderBy('created_at')->first();
            $payment = new Payment;
            $payment->store_id = $o->store_id;
            $payment->order_id = $o->id;
            $payment->provider = 'manual';
            $payment->type = 'refund';
            $payment->status = 'succeeded';
            $payment->amount = (int) $input['amount'];
            $payment->currency = $o->currency;
            $payment->method = $input['method'];
            $payment->reference = $input['reference'] ?? null;
            $payment->note = $input['note'] ?? null;
            $payment->parent_payment_id = $charge?->id;
            $payment->idempotency_key = $idempotencyKey;
            $payment->actor_user_id = $user?->getKey();
            $payment->return_request_id = $return?->id;
            $payment->save();
            if ($return !== null) {
                $this->returns->recordRefund($return, $payment, $user);
            }

            $o->refunded_amount += $payment->amount;
            $o->payment_status = $o->refunded_amount >= $o->paid_amount ? 'refunded' : 'partially_refunded';
            $o->revision++;
            $o->save();
            if ($o->customer_id !== null) {
                $amount = (int) $payment->amount;
                Customer::withTrashed()->whereKey($o->customer_id)->update([
                    'total_spent_amount' => DB::raw("CASE WHEN total_spent_amount >= {$amount} THEN total_spent_amount - {$amount} ELSE 0 END"),
                ]);
            }
            OrderTimeline::record($o, 'refund', $user, $payment->note, ['amount' => $payment->amount, 'method' => $payment->method, 'payment_id' => $payment->id] + ($return !== null ? ['return_id' => $return->id, 'return_number' => $return->number] : []));
            $this->audit->log('order.refunded', $o, ['amount' => $payment->amount, 'method' => $payment->method], $user);

            return $payment;
        });

        return $payment;
    }

    /**
     * PATCH (P5-20): contact, address, note, tags while pending / confirmed / ready_to_ship. Returns the order and the
     * shipping hint for a changed address (not applied automatically).
     *
     * @param  array<string, mixed>  $input  validated UpdateOrderInput
     * @return array{0: Order, 1: array<string, mixed>|null}
     */
    public function update(Order $order, array $input, ?User $user): array
    {
        return DB::transaction(function () use ($order, $input, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($o->revision !== (int) $input['revision']) {
                throw StoreThemeService::conflict();
            }
            if (! in_array($o->status, Order::EDITABLE, true)) {
                throw new ApiException(409, 'invalid_state_transition', 'This order can’t be edited any more.');
            }
            $changed = [];
            $contact = $input['contact'] ?? [];
            if (array_key_exists('name', $contact) && $contact['name'] !== $o->customer_name) {
                $o->customer_name = AddressValidator::clean($contact['name']) ?? $o->customer_name;
                $changed[] = 'contact.name';
            }
            if (array_key_exists('phone', $contact)) {
                $phone = Phone::bdMsisdn($contact['phone']);
                if ($phone !== $o->customer_phone) {
                    $o->customer_phone = (string) $phone;
                    $changed[] = 'contact.phone';
                }
            }
            if (array_key_exists('email', $contact)) {
                $email = $contact['email'] !== null ? strtolower(trim($contact['email'])) : null;
                if ($email !== $o->customer_email) {
                    $o->customer_email = $email;
                    $changed[] = 'contact.email';
                }
            }
            $hint = null;
            if (array_key_exists('shipping_address', $input)) {
                $address = $this->addresses->snapshot($input['shipping_address']);
                if ($address != $o->shipping_address) {
                    $o->shipping_address = $address;
                    $o->district_code = $address['district_code'];
                    $changed[] = 'shipping_address';
                    $hint = $this->zones->quote($o->store_id, $address['district_code'], $address['thana_code'], $o->subtotal_amount - $o->discount_amount);
                }
            }
            if (array_key_exists('customer_note', $input) && $input['customer_note'] !== $o->customer_note) {
                $o->customer_note = $input['customer_note'];
                $changed[] = 'customer_note';
            }
            if (array_key_exists('tags', $input)) {
                $tags = array_values(array_unique(array_filter(array_map(fn ($t) => AddressValidator::clean($t), $input['tags']))));
                if ($tags !== $o->tags) {
                    $o->tags = $tags;
                    $changed[] = 'tags';
                }
            }
            if ($changed !== []) {
                $o->revision++;
                $o->save();
                OrderTimeline::record($o, 'edited', $user, null, ['fields' => $changed]);
            }

            return [$o, $hint];
        });
    }

    public function note(Order $order, string $body, ?User $user): OrderEvent
    {
        return OrderTimeline::record($order, 'note', $user, $body);
    }

    /**
     * Bulk confirm / mark packed: each order in its own transaction; wrong states are skipped, not fatal.
     *
     * @param  list<string>  $ids  already checked to belong to the store
     * @return array{action: string, updated: int, skipped: list<array{id: string, reason: string}>}
     */
    public function bulk(Store $store, string $action, array $ids, ?User $user): array
    {
        $from = $action === 'confirm' ? Order::PENDING : Order::CONFIRMED;
        $updated = 0;
        $skipped = [];
        foreach ($ids as $id) {
            $order = Order::query()->where('store_id', $store->id)->whereKey($id)->first();
            try {
                if ($order === null || $order->status !== $from) {
                    throw new ApiException(409, 'invalid_state_transition', 'Wrong state.');
                }
                $action === 'confirm' ? $this->confirm($order, $user) : $this->ready($order, $user);
                $updated++;
            } catch (ApiException $e) {
                if (! in_array($e->errorCode, ['invalid_state_transition', 'order_held'], true)) {
                    throw $e;
                }
                $skipped[] = ['id' => $id, 'reason' => $e->errorCode]; // PHASE-8-8 §5.5: held → `order_held`
            }
        }

        return ['action' => $action, 'updated' => $updated, 'skipped' => $skipped];
    }

    /**
     * @param  callable(Order): void|null  $effects
     * @param  array<string, mixed>  $meta
     */
    private function transition(Order $order, string $to, ?User $user, ?callable $effects = null, ?string $body = null, array $meta = []): Order
    {
        return DB::transaction(function () use ($order, $to, $user, $effects, $body, $meta) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            $from = $o->status;
            if (in_array($to, [Order::CONFIRMED, Order::READY_TO_SHIP], true)) {
                FraudGuard::assertNotHeld($o); // PHASE-8-8 §5.5 (S156): released (or advance paid) first → 409 order_held
            }
            OrderStateMachine::assert($from, $to);
            if ($effects !== null) {
                $effects($o);
            }
            $o->status = $to;
            $o->revision++;
            $o->save();
            OrderTimeline::record($o, 'status_changed', $user, $body, $meta, $from, $to);
            WebhookEvents::orderStatus($o, $to);

            return $o;
        });
    }
}
