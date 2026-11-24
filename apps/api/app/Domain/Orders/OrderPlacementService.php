<?php

namespace App\Domain\Orders;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Cart\CartService;
use App\Domain\Cart\Models\Cart;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\CouponValidator;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Marketing\Attribution;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Payments\PaymentService;
use App\Domain\Pricing\CartPricer;
use App\Domain\Pricing\LineLoader;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Shared\Support\Money;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * The one placement path for storefront checkout and manual orders (P5-19, §3.4). One transaction with the fixed lock
 * order of §7: cart → inventories (variant_id) → coupon → customer → store counter. Nothing is written on failure.
 *
 * Input keys: contact {name, phone (8801…), email}, address (AddressValidator snapshot), customer_note,
 * accepts_marketing, coupon_code, shipping_override, channel, customer_id, user, idempotency_key, expected_total,
 * ip, user_agent, notify, items (manual: [{variant_id, quantity}]).
 */
class OrderPlacementService
{
    /** The pending online charge placeLocked() created (checkout only). */
    private ?Payment $lastCharge = null;

    public function __construct(
        private readonly InventoryService $inventory,
        private readonly CouponValidator $coupons,
        private readonly ZoneResolver $zones,
        private readonly CartService $carts,
        private readonly OrderNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /**
     * Storefront checkout. Returns the order, the raw confirmation token (stored hashed) and, for online payments
     * and required advances (P5B-13/14/15), the PaymentInitiation: the order commits first (`pending_payment`,
     * 30-min hold, one pending charge), then the gateway is called OUTSIDE the transaction.
     *
     * @param  array<string, mixed>  $input
     * @return array{order: Order, token: string, payment: array<string, mixed>|null}
     */
    public function checkout(Store $store, string $cartToken, array $input): array
    {
        if ($store->status !== Store::STATUS_ACTIVE) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Orders open after you go live.");
        }
        $payments = app(PaymentService::class); // resolved lazily: PaymentService → OrderService → ReturnService → this
        $method = $input['payment_method'] ?? null;
        $online = null;
        $advance = null;
        if ($method === 'cod') {
            $this->assertPaymentMethod($store, 'cod');
            // P5B-13: the advance gateway matters only when the shop requires it (checked against the shipping below).
            if (($input['advance_gateway'] ?? null) !== null) {
                $advance = $payments->usableAccount($store->id, (string) $input['advance_gateway'])
                    ?? throw PaymentService::methodUnavailable('advance_gateway', 'This payment method isn’t available.');
            }
        } else {
            $online = $payments->usableAccount($store->id, is_string($method) ? $method : null)
                ?? throw PaymentService::methodUnavailable('payment_method', 'This payment method isn’t available for this shop.');
        }
        $token = CartService::newToken();

        $charge = null;
        $this->lastCharge = null;
        $order = DB::transaction(function () use ($store, $cartToken, $input, $token, $online, $advance, &$charge) {
            $cart = $this->carts->require($store, $cartToken, lock: true);
            $items = DB::table('cart_items')->where('cart_id', $cart->id)->orderBy('created_at')->orderBy('id')->get(['id', 'variant_id', 'quantity']);
            if ($items->isEmpty()) {
                throw new ApiException(422, 'cart_empty', 'Your bag is empty.');
            }
            $lines = [];
            foreach ($items->values() as $i => $item) {
                $lines[] = ['key' => $i, 'variant_id' => $item->variant_id, 'quantity' => (int) $item->quantity];
            }

            $order = $this->placeLocked($store, $lines, $input + [
                'coupon_code' => $cart->coupon_code,
                'source' => 'storefront',
                'channel' => 'website',
                'confirmation_token' => $token,
                'online_account' => $online,
                'advance_account' => $advance,
            ], [Product::ACTIVE]);
            $charge = $this->lastCharge;
            $this->lastCharge = null;

            $cart->status = Cart::CONVERTED;
            $cart->converted_order_id = $order->id;
            $cart->last_activity_at = now();
            $cart->save();

            return $order;
        });

        if ($order->status === Order::PENDING_PAYMENT && $charge !== null) {
            // P5B-14: the shopper SMS and the merchant email wait until the order leaves pending_payment.
            return ['order' => $order, 'token' => $token, 'payment' => $payments->initiate($charge)];
        }
        $this->notifier->placed($order, null);

        return ['order' => $order, 'token' => $token, 'payment' => null];
    }

    /**
     * Manual order (POST /stores/{store}/orders): same pricing; plan limit checked under a per-store lock (S17).
     *
     * @param  array<string, mixed>  $input
     */
    public function manual(Store $store, array $input): Order
    {
        $this->assertPaymentMethod($store, $input['payment_method'] ?? 'cod', manual: true);
        $lines = [];
        foreach (array_values($input['items']) as $i => $item) {
            $lines[] = ['key' => $i, 'variant_id' => strtolower((string) $item['variant_id']), 'quantity' => (int) $item['quantity']];
        }

        $order = DB::transaction(function () use ($store, $input, $lines) {
            if (DB::getDriverName() === 'pgsql') {
                DB::select('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['orders:'.$store->id]);
            }
            FeatureGate::assertWithin($this->context->tenant(), Limit::OrdersPerMonth);

            return $this->placeLocked($store, $lines, $input + ['source' => 'dashboard'], [Product::ACTIVE, Product::DRAFT]);
        });

        $this->notifier->placed($order, $input['notify'] ?? null);

        return $order;
    }

    /**
     * Exchange order (P5B-67): a manual order inside the CALLER's transaction (ReturnService holds the original order
     * and the return row locked). Same plan limit as manual orders. Input as manual() plus `credit` (exchange credit,
     * allocated as a fixed discount over the lines, capped at the subtotal), `source_order_id` and `tags`.
     * Notifications are the caller's job (after commit).
     *
     * @param  array<string, mixed>  $input
     */
    public function placeExchange(Store $store, array $input): Order
    {
        $lines = [];
        foreach (array_values($input['items']) as $i => $item) {
            $lines[] = ['key' => $i, 'variant_id' => strtolower((string) $item['variant_id']), 'quantity' => (int) $item['quantity']];
        }
        if (DB::getDriverName() === 'pgsql') {
            DB::select('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['orders:'.$store->id]);
        }
        FeatureGate::assertWithin($this->context->tenant(), Limit::OrdersPerMonth);

        return $this->placeLocked($store, $lines, $input + ['source' => 'dashboard', 'coupon_code' => null], [Product::ACTIVE, Product::DRAFT]);
    }

    public function notifyPlaced(Order $order, ?bool $notify): void
    {
        $this->notifier->placed($order, $notify);
    }

    /**
     * OrderQuote (POST /orders/quote): the same math without writes; stock and coupon problems come back as data.
     *
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    public function quote(Store $store, array $input): array
    {
        $lines = [];
        foreach (array_values($input['items'] ?? []) as $i => $item) {
            $lines[] = ['key' => $i, 'variant_id' => strtolower((string) $item['variant_id']), 'quantity' => (int) $item['quantity']];
        }
        $loaded = LineLoader::load($store->id, $lines, [Product::ACTIVE, Product::DRAFT]);
        // Foreign-id rule: a variant that isn't this store's (or no longer exists) is a 422 with the field path, as on
        // create. Archived products and disabled variants stay quote data (`issue: unavailable`).
        $unknown = [];
        foreach ($loaded['lines'] as $i => $line) {
            $variant = $loaded['variants'][$line['variant_id']] ?? null;
            if ($variant === null || $variant->trashed() || $variant->product === null || $variant->product->trashed()) {
                $unknown["items.{$i}.variant_id"] = ['Unknown variant.'];
            }
        }
        if ($unknown !== []) {
            throw ValidationException::withMessages($unknown);
        }
        $phone = $input['contact']['phone'] ?? null;

        $coupon = null;
        $couponError = null;
        $pricedPlain = CartPricer::price($loaded['lines']);
        if (($input['coupon_code'] ?? null) !== null && $input['coupon_code'] !== '') {
            $coupon = $this->coupons->find($store->id, $input['coupon_code']);
            if ($coupon === null) {
                $couponError = CouponValidator::NOT_FOUND;
            } else {
                $withCoupon = CartPricer::price($loaded['lines'], $this->coupons->pricingInput($coupon));
                $couponError = $this->coupons->reason($coupon, $withCoupon['subtotal'], $withCoupon['eligible_subtotal'], $phone);
            }
            if ($couponError !== null) {
                $coupon = null;
            }
        }
        $priced = $coupon ? CartPricer::price($loaded['lines'], $this->coupons->pricingInput($coupon)) : $pricedPlain;

        $zone = null;
        $shipping = ['shipping' => 0];
        $address = $input['address'] ?? null;
        $override = $input['shipping_override'] ?? null;
        if ($address !== null) {
            $zone = $this->zones->quote($store->id, $address['district_code'], $address['thana_code'], $priced['subtotal'] - $priced['discount']);
            if ($zone !== null && $coupon?->type === Coupon::FREE_SHIPPING) {
                $zone['amount'] = 0;
                $zone['is_free'] = true;
            }
            $shipping = CartPricer::shipping($zone['charge_amount'] ?? 0, ZoneResolver::freeOver($store->id), $priced['subtotal'] - $priced['discount'], $coupon?->type === Coupon::FREE_SHIPPING, $override);
        } elseif ($override !== null) {
            $shipping = ['shipping' => (int) $override];
        }

        $costs = $this->context->allows(Permission::CostsView);
        $quoteLines = [];
        foreach ($priced['lines'] as $i => $line) {
            $variant = $loaded['variants'][$loaded['lines'][$i]['variant_id']] ?? null;
            $quoteLines[] = OrderPresenter::quoteLine($variant, $loaded['lines'][$i], $line, $costs);
        }

        return [
            'lines' => $quoteLines,
            'zone' => $zone,
            'coupon_error' => $couponError,
            'subtotal_amount' => $priced['subtotal'],
            'discount_amount' => $priced['discount'],
            'shipping_amount' => $shipping['shipping'],
            'total_amount' => $priced['subtotal'] - $priced['discount'] + $shipping['shipping'],
            'customer' => $phone !== null ? OrderPresenter::customerSummary(
                Customer::query()->where('store_id', $store->id)->where('phone', $phone)->first(), null,
            ) : null,
        ];
    }

    /**
     * Steps 2–8 of §3.4 inside the caller's transaction.
     *
     * @param  list<array{key: int, variant_id: string, quantity: int}>  $lines
     * @param  array<string, mixed>  $input
     * @param  list<string>  $statuses
     */
    private function placeLocked(Store $store, array $lines, array $input, array $statuses): Order
    {
        $storefront = $input['source'] === 'storefront';
        $phone = (string) $input['contact']['phone'];
        $field = fn (int $i, string $f) => "items.{$i}.{$f}";

        // 2. Price lines; any issue line → 422.
        $loaded = LineLoader::load($store->id, $lines, $statuses);
        $this->assertLines($loaded, $lines, $storefront);
        $plain = CartPricer::price($loaded['lines']);

        // 3. Commit stock (inventories locked by variant_id).
        $commit = [];
        foreach ($loaded['lines'] as $i => $line) {
            if ($line['tracked']) {
                $commit[] = ['variant_id' => $line['variant_id'], 'quantity' => $line['quantity'], 'allow_backorder' => $line['backorder'], 'field' => $field($i, 'quantity')];
            }
        }
        $this->inventory->commit($store->id, $commit);

        // 4. Coupon: lock, validate fully (incl. phone rules), price and allocate.
        $coupon = null;
        $priced = $plain;
        $code = $input['coupon_code'] ?? null;
        if (is_string($code) && trim($code) !== '') {
            $coupon = $this->coupons->find($store->id, $code, lock: true);
            if ($coupon === null) {
                throw CartService::couponInvalid(CouponValidator::NOT_FOUND);
            }
            $priced = CartPricer::price($loaded['lines'], $this->coupons->pricingInput($coupon));
            $reason = $this->coupons->reason($coupon, $priced['subtotal'], $priced['eligible_subtotal'], $phone);
            if ($reason !== null) {
                throw CartService::couponInvalid($reason);
            }
        }

        // 4b. Exchange credit (P5B-67): a fixed discount (not a coupon), capped at the merchandise after discount,
        // allocated over the lines with the same largest-remainder rule (P5-12).
        $creditApplied = 0;
        if (($input['credit'] ?? 0) > 0) {
            $creditApplied = min((int) $input['credit'], $priced['subtotal'] - $priced['discount']);
            $shares = CartPricer::allocate($creditApplied, array_map(fn ($l) => $l['line_amount'] - $l['discount_amount'], $priced['lines']));
            foreach ($shares as $i => $share) {
                $priced['lines'][$i]['discount_amount'] += $share;
            }
            $priced['discount'] += $creditApplied;
        }

        // 5. Zone, free delivery, free-shipping coupon, merchant override.
        $address = $input['address'];
        $merchandise = $priced['subtotal'] - $priced['discount'];
        $zone = $this->zones->resolve($store->id, $address['district_code'], $address['thana_code']);
        $override = $storefront ? null : ($input['shipping_override'] ?? null);
        $shipping = CartPricer::shipping($zone?->charge_amount ?? 0, ZoneResolver::freeOver($store->id), $merchandise, $coupon?->type === Coupon::FREE_SHIPPING, $override);
        $computedShipping = $override !== null
            ? CartPricer::shipping($zone?->charge_amount ?? 0, ZoneResolver::freeOver($store->id), $merchandise, $coupon?->type === Coupon::FREE_SHIPPING)['shipping']
            : null;

        // 6. Total; the shopper's expected total must match (P5-15).
        $total = $merchandise + $shipping['shipping'];
        if ($storefront && (int) $input['expected_total'] !== $total) {
            throw new ApiException(409, 'checkout_changed', 'The total changed. Check your order and place it again.', [
                'expected_total_amount' => ['The total changed to '.Money::bdt($total).'. Check your order and place it again.'],
            ]);
        }

        // 7. Customer (by phone; manual orders may name one).
        $customer = $this->customer($store, $input, $address);

        // 8. Number, order, items, events, payment, redemption.
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();
        $sequence = StoreCounter::next($store->id, StoreCounter::ORDERS);
        $user = $input['user'] ?? null;
        $now = now();

        $order = new Order;
        $order->store_id = $store->id;
        $order->sequence = $sequence;
        $order->number = self::prefix($store, $settings).'-'.$sequence;
        // 5b-2: online payment of the total, or the delivery charge in advance on a COD order (P5B-13/14).
        $online = $total > 0 ? ($input['online_account'] ?? null) : null;
        $advanceAmount = 0;
        if ($storefront && $online === null && $total > 0 && PaymentService::advanceRequired($settings, $shipping['shipping'])) {
            if (($input['advance_account'] ?? null) === null) {
                throw new ApiException(422, 'advance_required', 'Pay the delivery charge online to place this order.', [
                    'advance_gateway' => ['Choose how to pay the delivery charge.'],
                ]);
            }
            $advanceAmount = $shipping['shipping'];
        }
        $hold = $online !== null || $advanceAmount > 0;

        $order->status = $hold ? Order::PENDING_PAYMENT : Order::PENDING;
        $order->payment_status = $total === 0 ? 'paid' : 'unpaid';
        $order->payment_method = $online?->provider ?? 'cod';
        $order->created_via = $storefront ? 'storefront' : 'dashboard';
        $order->channel = $input['channel'];
        $order->customer_id = $customer->id;
        $order->customer_name = $input['contact']['name'];
        $order->customer_phone = $phone;
        $order->customer_email = $input['contact']['email'] ?? null;
        $order->shipping_address = $address;
        $order->district_code = $address['district_code'];
        $order->currency = $store->currency ?: 'BDT';
        $order->subtotal_amount = $priced['subtotal'];
        $order->discount_amount = $priced['discount'];
        $order->shipping_amount = $shipping['shipping'];
        $order->shipping_discount_amount = $shipping['shipping_discount'];
        $order->tax_amount = 0;
        $order->total_amount = $total;
        $order->coupon_id = $coupon?->id;
        $order->coupon_code = $coupon?->code;
        $order->shipping_zone_id = $zone?->id;
        $order->shipping_zone_name = $zone?->name ?? 'Delivery';
        $order->delivery_min_days = $zone?->min_days;
        $order->delivery_max_days = $zone?->max_days;
        $order->shipping_overridden = $override !== null;
        $order->customer_note = $input['customer_note'] ?? null;
        $order->tags = array_values($input['tags'] ?? []);
        $order->source_order_id = $input['source_order_id'] ?? null;
        $order->idempotency_key = $input['idempotency_key'] ?? null;
        if (isset($input['confirmation_token'])) {
            $order->confirmation_token_hash = hash('sha256', $input['confirmation_token']);
            $order->confirmation_expires_at = $now->copy()->addDay();
        }
        $order->placed_at = $now;
        $order->payment_expires_at = $hold ? $now->copy()->addMinutes((int) config('payments.hold_minutes', 30)) : null;
        $order->created_by = $storefront ? null : $user?->getKey();
        $order->ip = $input['ip'] ?? null;
        $order->user_agent = isset($input['user_agent']) ? Str::limit((string) $input['user_agent'], 252, '...') : null;
        $this->guardIdempotency(fn () => $order->save());

        foreach ($priced['lines'] as $i => $line) {
            $in = $loaded['lines'][$i];
            /** @var ProductVariant $variant */
            $variant = $loaded['variants'][$in['variant_id']];
            $product = $variant->product;
            $item = new OrderItem;
            $item->store_id = $store->id;
            $item->order_id = $order->id;
            $item->product_id = $product->id;
            $item->variant_id = $variant->id;
            $item->product_name = $product->name;
            $item->variant_title = $variant->title;
            $item->option_values = $variant->optionValues(count($product->options ?? []));
            $item->sku = $variant->sku;
            $item->image_media_id = $variant->image_media_id ?? $product->images->first()?->media_id;
            $item->unit_price_amount = $line['unit_price_amount'];
            $item->compare_at_amount = $line['compare_at_amount'];
            $item->unit_cost_amount = $variant->cost_amount;
            $item->quantity = $in['quantity'];
            $item->subtotal_amount = $line['line_amount'];
            $item->discount_amount = $line['discount_amount'];
            $item->total_amount = $line['line_amount'] - $line['discount_amount'];
            $item->tracked = $in['tracked'];
            $item->position = $i;
            $item->save();
        }

        $meta = ['channel' => $order->channel, 'created_via' => $order->created_via];
        if ($creditApplied > 0 || isset($input['source_order_id'])) {
            $meta += ['exchange_credit_amount' => $creditApplied, 'source_order_id' => $input['source_order_id'] ?? null];
        }
        if ($override !== null) {
            $meta += ['shipping_overridden' => true, 'computed_shipping_amount' => $computedShipping, 'shipping_amount' => $override];
        }
        OrderTimeline::record($order, 'placed', $storefront ? null : $user, null, $meta, null, $order->status, $storefront ? 'customer' : null);
        WebhookEvents::emit(WebhookEventType::OrderCreated, $order);
        Attribution::orderPlaced($order); // PHASE-8-5 §5.5: campaign attribution, queued after commit

        if ($hold) {
            $payments = app(PaymentService::class);
            $charge = $online !== null
                ? $payments->newCharge($order, $online, Payment::PURPOSE_ORDER, $total, $order->payment_expires_at)
                : $payments->newCharge($order, $input['advance_account'], Payment::PURPOSE_ADVANCE, $advanceAmount, $order->payment_expires_at);
            $this->lastCharge = $charge;
        }

        if ($total - $advanceAmount > 0 && $online === null) {
            $payment = new Payment;
            $payment->store_id = $store->id;
            $payment->order_id = $order->id;
            $payment->provider = 'cod';
            $payment->type = 'charge';
            $payment->status = 'pending';
            $payment->amount = $total - $advanceAmount;
            $payment->currency = $order->currency;
            $payment->save();
        }

        if ($coupon !== null) {
            $redemption = new CouponRedemption;
            $redemption->store_id = $store->id;
            $redemption->coupon_id = $coupon->id;
            $redemption->order_id = $order->id;
            $redemption->customer_phone = $phone;
            $redemption->discount_amount = $priced['discount'] + $shipping['coupon_shipping_discount'];
            $redemption->save();
            Coupon::query()->whereKey($coupon->id)->update(['used_count' => DB::raw('used_count + 1')]);
        }

        if ($override !== null) {
            $this->audit->log('order.shipping_overridden', $order, ['computed' => $computedShipping, 'override' => $override], $user);
        }

        // PHASE-8-8 §5.1 (P88-6): `checking` hold for guarded storefront COD orders; the risk check runs after commit.
        app(FraudGuard::class)->onPlaced($order, (array) ($input['guard_flags'] ?? []));

        return $order;
    }

    /**
     * @param  array{lines: list<array<string, mixed>>, variants: array<string, ProductVariant>}  $loaded
     * @param  list<array{key: int, variant_id: string, quantity: int}>  $lines
     */
    private function assertLines(array $loaded, array $lines, bool $storefront): void
    {
        if ($loaded['lines'] === []) {
            throw new ApiException(422, 'cart_empty', 'Your bag is empty.');
        }
        $priced = CartPricer::price($loaded['lines']);
        $unknown = [];
        $stock = [];
        foreach ($priced['lines'] as $i => $line) {
            $in = $loaded['lines'][$i];
            if ($line['issue'] === 'insufficient_stock') {
                $stock["items.{$i}.quantity"] = [InventoryService::shortage((int) $line['max_quantity'])];
            } elseif ($line['issue'] === 'unavailable') {
                if ($storefront) {
                    $stock["items.{$i}.quantity"] = ['This item is no longer available.'];
                } else {
                    $variant = $loaded['variants'][$in['variant_id']] ?? null;
                    $unknown["items.{$i}.variant_id"] = [match (true) {
                        $variant === null || $variant->trashed() || $variant->product === null || $variant->product->trashed() => 'Unknown variant.',
                        $variant->product->status === Product::ARCHIVED => 'This product is archived.',
                        default => 'This variant is turned off.',
                    }];
                }
            }
        }
        if ($unknown !== []) {
            throw ValidationException::withMessages($unknown);
        }
        if ($stock !== []) {
            throw new ApiException(422, 'out_of_stock', 'Some items are no longer available in that quantity.', $stock);
        }
        // Re-checked by InventoryService::commit under the row locks (the authoritative check).
    }

    /** @param array<string, mixed> $input @param array<string, mixed> $address */
    private function customer(Store $store, array $input, array $address): Customer
    {
        $phone = (string) $input['contact']['phone'];
        $email = $input['contact']['email'] ?? null;
        $customer = null;
        if (($input['customer_id'] ?? null) !== null) {
            $customer = Customer::query()->where('store_id', $store->id)->whereKey(strtolower($input['customer_id']))->first()
                ?? throw ValidationException::withMessages(['customer_id' => ['Unknown customer.']]);
        }
        $customer ??= Customer::query()->where('store_id', $store->id)->where('phone', $phone)->first();

        if ($customer === null) {
            try {
                $customer = DB::transaction(function () use ($store, $input, $phone, $email, $address) {
                    $emailFree = $email !== null && ! Customer::query()->where('store_id', $store->id)->where('email', $email)->exists();
                    $c = new Customer([
                        'name' => $input['contact']['name'],
                        'phone' => $phone,
                        'email' => $emailFree ? $email : null,
                        'district' => $address['district'],
                        'area' => $address['area'] ?? $address['thana'],
                        'channel' => in_array($input['channel'], Customer::CHANNELS, true) ? $input['channel'] : 'other',
                        'accepts_marketing' => (bool) ($input['accepts_marketing'] ?? false),
                    ]);
                    $c->store_id = $store->id;
                    $c->source = $input['source'] === 'storefront' ? 'storefront' : Customer::SOURCE_MANUAL;
                    $c->created_by = $input['source'] === 'storefront' ? null : ($input['user'] ?? null)?->getKey();
                    $c->save();
                    WebhookEvents::emit(WebhookEventType::CustomerCreated, $c);

                    return $c;
                });
            } catch (QueryException) {
                // A parallel first order with the same phone won the insert (savepoint rolled back): use that row.
                $customer = Customer::query()->where('store_id', $store->id)->where('phone', $phone)->firstOrFail();
            }
        } else {
            // Existing customer: fill empty email / district / area only; never overwrite the name (§3.4 step 7).
            $fill = [];
            if ($customer->email === null && $email !== null && ! Customer::query()->where('store_id', $store->id)->where('email', $email)->exists()) {
                $fill['email'] = $email;
            }
            if ($customer->district === null) {
                $fill['district'] = $address['district'];
            }
            if ($customer->area === null) {
                $fill['area'] = $address['area'] ?? $address['thana'];
            }
            if ($fill !== []) {
                Customer::query()->whereKey($customer->id)->update($fill + ['updated_at' => now()]);
            }
        }

        Customer::query()->whereKey($customer->id)->update([
            'orders_count' => DB::raw('orders_count + 1'),
            'last_order_at' => now(),
        ]);

        return $customer;
    }

    /** P5-16: settings prefix, else the first two ASCII letters of the slug ("demo" → "DE"). */
    public static function prefix(Store $store, ?StoreSetting $settings): string
    {
        if ($settings?->order_prefix) {
            return $settings->order_prefix;
        }
        $letters = strtoupper(substr((string) preg_replace('/[^a-z]/i', '', $store->slug), 0, 2));

        return $letters !== '' ? $letters : 'SP';
    }

    private function assertPaymentMethod(Store $store, mixed $method, bool $manual = false): void
    {
        $cod = (bool) (StoreSetting::query()->where('store_id', $store->id)->value('cod_enabled') ?? true);
        if ($method !== 'cod' || (! $cod && ! $manual)) {
            throw new ApiException(422, 'payment_method_unavailable', 'Cash on delivery isn’t available for this shop.', [
                'payment_method' => ['Cash on delivery isn’t available for this shop.'],
            ]);
        }
    }

    private function guardIdempotency(callable $save): void
    {
        try {
            $save();
        } catch (QueryException $e) {
            if (str_contains($e->getMessage(), 'orders_store_idempotency_unique') || str_contains($e->getMessage(), 'orders.store_id, orders.idempotency_key')) {
                throw new ApiException(409, 'idempotency_key_in_use', 'This order is already being placed. Wait a moment and check your orders.');
            }
            throw $e;
        }
    }
}
