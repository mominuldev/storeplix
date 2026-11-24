<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Cart\CartService;
use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\Customer;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Stores\Models\Store;
use Throwable;

/**
 * The thing a run is about (PHASE-8-6 §4.1/§4.2), loaded inside the tenant: an order (delivered / unfinished online
 * order), a cart (abandoned checkout), a return request or an inventory row — with the customer and, for recovery,
 * the checkout contact (normalized phone, optional email/name). `context()` is the snapshot stored on the run so the
 * log survives cart pruning; `contact_name` there is internal (shown only with customers.view).
 */
final class Subject
{
    /**
     * @param  array{name: string, slug: string|null, image_media_id: string|null}|null  $product  first cart/order line
     * @param  array<string, mixed>  $context
     */
    public function __construct(
        public readonly string $type,
        public readonly string $id,
        public readonly string $label,
        public readonly ?Order $order = null,
        public readonly ?Cart $cart = null,
        public readonly ?ReturnRequest $returnRequest = null,
        public readonly ?Inventory $inventory = null,
        public readonly ?Customer $customer = null,
        public readonly ?string $phone = null,
        public readonly ?string $email = null,
        public readonly ?string $name = null,
        public readonly ?array $product = null,
        public readonly array $context = [],
    ) {}

    public static function load(Store $store, string $type, string $id): ?self
    {
        return match ($type) {
            'order' => self::order($store, $id),
            'cart' => self::cart($store, $id),
            'return' => self::returnRequest($store, $id),
            'inventory' => self::inventory($store, $id),
            default => null,
        };
    }

    /** The customer's (or, for recovery, the contact's) address for a channel. */
    public function address(string $channel, bool $contact): ?string
    {
        if ($contact) {
            return $channel === Campaign::SMS ? $this->phone : $this->email;
        }

        return $this->customer !== null ? MarketingAddress::ofCustomer($this->customer, $channel) : null;
    }

    private static function order(Store $store, string $id): ?self
    {
        $order = Order::query()->where('store_id', $store->id)->find(strtolower($id));
        if ($order === null) {
            return null;
        }
        $customer = $order->customer_id !== null ? Customer::query()->find($order->customer_id) : null;
        $item = OrderItem::query()->where('order_id', $order->id)->orderBy('position')->first();
        $slug = $item?->product_id !== null ? (string) (Product::withTrashed()->whereKey($item->product_id)->value('slug') ?? '') : '';
        $product = $item !== null ? ['name' => (string) $item->product_name, 'slug' => $slug !== '' ? $slug : null, 'image_media_id' => $item->image_media_id] : null;
        $lines = (int) OrderItem::query()->where('order_id', $order->id)->sum('quantity');

        return new self(
            type: 'order',
            id: $order->id,
            label: (string) $order->number,
            order: $order,
            customer: $customer,
            phone: MarketingAddress::normalize(Campaign::SMS, $order->customer_phone),
            email: MarketingAddress::normalize(Campaign::EMAIL, $order->customer_email),
            name: $order->customer_name ?: $customer?->name,
            product: $product,
            context: array_filter([
                'order_number' => (string) $order->number,
                'order_total_amount' => (int) $order->total_amount,
                'cart_line_count' => $lines,
                'first_product_name' => $product['name'] ?? null,
                'first_product_image_media_id' => $product['image_media_id'] ?? null,
                'currency' => (string) $order->currency,
                'contact_name' => $order->customer_name ?: $customer?->name,
            ], fn ($v) => $v !== null),
        );
    }

    private static function cart(Store $store, string $id): ?self
    {
        $cart = Cart::query()->where('store_id', $store->id)->find(strtolower($id));
        if ($cart === null) {
            return null;
        }
        $items = CartItem::query()->where('cart_id', $cart->id)->orderBy('created_at')->orderBy('id')->get();
        $first = $items->first();
        $variant = $first !== null ? ProductVariant::withTrashed()->with(['product' => fn ($q) => $q->withTrashed()->with('images')])->find($first->variant_id) : null;
        $product = null;
        if ($variant?->product !== null) {
            $product = [
                'name' => (string) $variant->product->name,
                'slug' => (string) $variant->product->slug ?: null,
                'image_media_id' => $variant->image_media_id ?? $variant->product->images->sortBy('position')->first()?->media_id,
            ];
        }
        $total = 0;
        try {
            $priced = app(CartService::class)->price($store, $cart, false, null);
            $total = (int) $priced['subtotal'] - (int) $priced['discount'];
        } catch (Throwable $e) {
            report($e);
        }
        $customer = $cart->contact_phone !== null
            ? Customer::query()->where('store_id', $store->id)->where('phone', $cart->contact_phone)->first()
            : null;
        $count = (int) $items->sum('quantity');

        return new self(
            type: 'cart',
            id: $cart->id,
            label: 'Cart · '.$count.' '.($count === 1 ? 'item' : 'items'),
            cart: $cart,
            customer: $customer,
            phone: MarketingAddress::normalize(Campaign::SMS, $cart->contact_phone),
            email: MarketingAddress::normalize(Campaign::EMAIL, $cart->contact_email),
            name: $cart->contact_name ?: $customer?->name,
            product: $product,
            context: array_filter([
                'cart_line_count' => $count,
                'cart_total_amount' => $total,
                'first_product_name' => $product['name'] ?? null,
                'first_product_image_media_id' => $product['image_media_id'] ?? null,
                'currency' => (string) ($cart->currency ?: $store->currency),
                'contact_name' => $cart->contact_name ?: $customer?->name,
            ], fn ($v) => $v !== null),
        );
    }

    private static function returnRequest(Store $store, string $id): ?self
    {
        $return = ReturnRequest::query()->where('store_id', $store->id)->find(strtolower($id));
        if ($return === null) {
            return null;
        }
        $order = Order::query()->find($return->order_id);
        $customer = $order?->customer_id !== null ? Customer::query()->find($order->customer_id) : null;

        return new self(
            type: 'return',
            id: $return->id,
            label: (string) $return->number,
            order: $order,
            returnRequest: $return,
            customer: $customer,
            phone: MarketingAddress::normalize(Campaign::SMS, $order?->customer_phone),
            name: $customer?->name ?? $order?->customer_name,
            context: array_filter([
                'return_number' => (string) $return->number,
                'order_number' => $order?->number,
                'order_total_amount' => $order !== null ? (int) $order->total_amount : null,
                'currency' => $order?->currency ?? $store->currency,
                'contact_name' => $customer?->name ?? $order?->customer_name,
            ], fn ($v) => $v !== null),
        );
    }

    private static function inventory(Store $store, string $id): ?self
    {
        $row = Inventory::query()->where('store_id', $store->id)->find(strtolower($id));
        if ($row === null) {
            return null;
        }
        $variant = ProductVariant::withTrashed()->with(['product' => fn ($q) => $q->withTrashed()])->find($row->variant_id);
        $productName = (string) ($variant?->product?->name ?? 'Product');
        $variantName = $variant !== null && ! $variant->is_default && trim((string) $variant->title) !== '' ? (string) $variant->title : null;

        return new self(
            type: 'inventory',
            id: $row->id,
            label: $variantName !== null ? $productName.' · '.$variantName : $productName,
            inventory: $row,
            product: ['name' => $productName, 'slug' => $variant?->product?->slug, 'image_media_id' => $variant?->image_media_id],
            context: array_filter([
                'product_name' => $productName,
                'variant_name' => $variantName,
                'on_hand' => (int) $row->on_hand,
                'product_id' => $variant?->product_id,
            ], fn ($v) => $v !== null),
        );
    }
}
