<?php

namespace App\Domain\Cart;

use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\CouponValidator;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Inventory\InventoryService;
use App\Domain\Pricing\CartPricer;
use App\Domain\Pricing\LineLoader;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * §3.3 server-side cart (P5-3, P5-4, ADR 0006). Variant ids and quantities only; everything else is recomputed on
 * every read. Adding never reserves stock.
 */
class CartService
{
    public function __construct(
        private readonly CouponValidator $coupons,
        private readonly ZoneResolver $zones,
    ) {}

    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    /** Active, unexpired cart of THIS store for the raw token; null otherwise (→ 404 cart_not_found). */
    public function find(Store $store, ?string $token, bool $lock = false): ?Cart
    {
        if ($token === null || preg_match('/^[A-Za-z0-9_-]{43}$/', $token) !== 1) {
            return null;
        }
        $cart = Cart::query()->where('store_id', $store->id)->where('token_hash', Cart::hashToken($token))
            ->when($lock, fn ($q) => $q->lockForUpdate())->first();
        if ($cart === null || $cart->status !== Cart::ACTIVE || $cart->last_activity_at->lt(now()->subDays(Cart::TTL_DAYS))) {
            return null;
        }

        return $cart;
    }

    public function require(Store $store, ?string $token, bool $lock = false): Cart
    {
        return $this->find($store, $token, $lock) ?? throw self::notFound();
    }

    public static function notFound(): ApiException
    {
        return new ApiException(404, 'cart_not_found', 'Your bag has expired. Add your items again.');
    }

    /** @return array{0: Cart, 1: string} the new cart and its raw token (returned once) */
    public function create(Store $store, string $ip): array
    {
        $token = self::newToken();
        $cart = new Cart;
        $cart->store_id = $store->id;
        $cart->token_hash = Cart::hashToken($token);
        $cart->currency = $store->currency ?: 'BDT';
        $cart->last_activity_at = now();
        $cart->ip = $ip;
        $cart->save();

        return [$cart, $token];
    }

    /** Validates the variant and stock BEFORE a cart is created, so a failed add never creates one. */
    public function assertAddable(Store $store, ?Cart $cart, string $variantId, int $quantity, bool $preview): void
    {
        $existing = $cart ? CartItem::query()->where('cart_id', $cart->id)->where('variant_id', strtolower($variantId))->first() : null;
        $target = min(Cart::MAX_QUANTITY, ($existing?->quantity ?? 0) + $quantity);
        $line = LineLoader::load($store->id, [['key' => 0, 'variant_id' => $variantId, 'quantity' => $target]], self::statuses($preview))['lines'][0];
        if (! $line['purchasable']) {
            throw ValidationException::withMessages(['variant_id' => ["This item isn't available."]]);
        }
        if ($existing === null && $cart !== null && CartItem::query()->where('cart_id', $cart->id)->count() >= Cart::MAX_LINES) {
            throw ValidationException::withMessages(['lines' => ['Your bag can hold 50 different items.']]);
        }
        $this->assertStock($line, 'quantity');
    }

    public function addItem(Store $store, Cart $cart, string $variantId, int $quantity): void
    {
        DB::transaction(function () use ($store, $cart, $variantId, $quantity) {
            $variantId = strtolower($variantId);
            $item = CartItem::query()->where('cart_id', $cart->id)->where('variant_id', $variantId)->lockForUpdate()->first();
            if ($item === null) {
                $item = new CartItem;
                $item->store_id = $store->id;
                $item->cart_id = $cart->id;
                $item->variant_id = $variantId;
                $item->quantity = 0;
            }
            $item->quantity = min(Cart::MAX_QUANTITY, $item->quantity + $quantity);
            $item->save();
            $this->touch($cart);
        });
    }

    public function updateItem(Store $store, Cart $cart, CartItem $item, int $quantity, bool $preview): void
    {
        $line = LineLoader::load($store->id, [['key' => 0, 'variant_id' => $item->variant_id, 'quantity' => $quantity]], self::statuses($preview))['lines'][0];
        if ($line['purchasable']) {
            $this->assertStock($line, 'quantity');
        }
        $item->quantity = $quantity;
        $item->save();
        $this->touch($cart);
    }

    public function removeItem(Cart $cart, CartItem $item): void
    {
        $item->delete();
        $this->touch($cart);
    }

    public function findItem(Cart $cart, string $itemId): CartItem
    {
        return CartItem::query()->where('cart_id', $cart->id)->whereKey(strtolower($itemId))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    public function applyCoupon(Store $store, Cart $cart, string $code, bool $preview): void
    {
        $coupon = $this->coupons->find($store->id, $code);
        if ($coupon === null) {
            throw self::couponInvalid(CouponValidator::NOT_FOUND);
        }
        $priced = $this->price($store, $cart, $preview, $coupon);
        $reason = $this->coupons->reason($coupon, $priced['subtotal'], $priced['eligible_subtotal']);
        if ($reason !== null) {
            throw self::couponInvalid($reason);
        }
        $cart->coupon_code = $coupon->code;
        $this->touch($cart);
    }

    public function removeCoupon(Cart $cart): void
    {
        $cart->coupon_code = null;
        $this->touch($cart);
    }

    public static function couponInvalid(string $reason): ApiException
    {
        return new ApiException(422, 'coupon_invalid', $reason, ['code' => [$reason]]);
    }

    /**
     * Cart payload with the coupon re-validated (an invalid coupon is removed with a notice).
     *
     * @return array{data: array<string, mixed>, notices: list<string>}
     */
    public function view(Store $store, Cart $cart, bool $preview): array
    {
        $notices = [];
        $coupon = $cart->coupon_code !== null ? $this->coupons->find($store->id, $cart->coupon_code) : null;
        $priced = $this->price($store, $cart, $preview, $coupon);
        if ($cart->coupon_code !== null) {
            $reason = $coupon === null ? CouponValidator::NOT_FOUND : $this->coupons->reason($coupon, $priced['subtotal'], $priced['eligible_subtotal']);
            if ($reason !== null) {
                $notices[] = "Code {$cart->coupon_code} was removed: {$reason}";
                $cart->coupon_code = null;
                $cart->save();
                $coupon = null;
                $priced = $this->price($store, $cart, $preview, null);
            }
        }

        return ['data' => CartPresenter::cart($store, $priced, $coupon), 'notices' => $notices];
    }

    /**
     * @return array<string, mixed> CartPricer result plus `items` (CartItem by key) and `variants`
     */
    public function price(Store $store, Cart $cart, bool $preview, ?Coupon $coupon): array
    {
        $items = CartItem::query()->where('cart_id', $cart->id)->orderBy('created_at')->orderBy('id')->get();
        $loaded = LineLoader::load($store->id, $items->map(fn (CartItem $i) => ['key' => $i->id, 'variant_id' => $i->variant_id, 'quantity' => $i->quantity])->all(), self::statuses($preview));
        $priced = CartPricer::price($loaded['lines'], $coupon ? $this->coupons->pricingInput($coupon) : null);

        return $priced + ['items' => $items->keyBy('id')->all(), 'variants' => $loaded['variants'], 'input' => $loaded['lines']];
    }

    /** @return array{zone_id: string, zone_name: string, min_days: int, max_days: int, charge_amount: int, amount: int, is_free: bool} */
    public function shippingQuote(Store $store, Cart $cart, string $districtCode, string $thanaCode, bool $preview): array
    {
        $coupon = $cart->coupon_code !== null ? $this->coupons->find($store->id, $cart->coupon_code) : null;
        $priced = $this->price($store, $cart, $preview, $coupon);
        $valid = $coupon !== null && $this->coupons->reason($coupon, $priced['subtotal'], $priced['eligible_subtotal']) === null;
        $discount = $valid ? $priced['discount'] : 0;
        $quote = $this->zones->quote($store->id, $districtCode, $thanaCode, $priced['subtotal'] - $discount);
        $quote ??= ['zone_id' => '', 'zone_name' => 'Delivery', 'min_days' => 0, 'max_days' => 0, 'charge_amount' => 0, 'amount' => 0, 'is_free' => true];
        if ($valid && $coupon->type === Coupon::FREE_SHIPPING) {
            $quote['amount'] = 0;
            $quote['is_free'] = true;
        }

        return $quote;
    }

    /** @return list<string> */
    public static function statuses(bool $preview): array
    {
        return $preview ? [Product::ACTIVE, Product::DRAFT] : [Product::ACTIVE];
    }

    /** @param array<string, mixed> $line */
    private function assertStock(array $line, string $field): void
    {
        if ($line['tracked'] && ! $line['backorder'] && $line['available'] < $line['quantity']) {
            throw new ApiException(422, 'out_of_stock', 'Not enough stock.', [$field => [InventoryService::shortage($line['available'])]]);
        }
    }

    private function touch(Cart $cart): void
    {
        $cart->last_activity_at = now();
        $cart->save();
    }
}
