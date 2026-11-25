<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Location;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\PermissionSet;
use Illuminate\Support\Facades\DB;

/** POS payloads (@storeplix/types, openapi 1.21.0): PosRegister, PosSession, PosCatalogItem, PosSale + PosReceipt. */
final class PosPresenter
{
    /** @return array<string, mixed> PosRegister */
    public static function register(PosRegister $register): array
    {
        /** @var Location|null $location */
        $location = $register->relationLoaded('location') ? $register->location : Location::query()->whereKey($register->location_id)->first();
        $open = PosSession::query()->where('register_id', $register->id)->where('status', PosSession::OPEN)->with('openedBy')->first();
        $last = PosSession::query()->where('register_id', $register->id)->where('status', PosSession::CLOSED)
            ->orderByDesc('closed_at')->orderByDesc('id')->first();
        $lastSales = $last === null ? null : DB::table('pos_sales')->join('orders', 'orders.id', '=', 'pos_sales.order_id')
            ->where('pos_sales.store_id', $register->store_id)->where('pos_sales.session_id', $last->id)
            ->selectRaw('count(*) as n, coalesce(sum(orders.total_amount), 0) as total')->first();

        return [
            'id' => $register->id,
            'name' => $register->name,
            'location' => ['id' => $register->location_id, 'name' => (string) $location?->name, 'type' => (string) ($location?->type ?? 'warehouse')],
            'position' => (int) $register->position,
            'archived_at' => UserRef::iso($register->archived_at),
            'open_session' => $open === null ? null : ['id' => $open->id, 'opened_at' => UserRef::iso($open->opened_at), 'opened_by' => UserRef::of($open->openedBy)],
            'last_session' => $last === null ? null : [
                'id' => $last->id,
                'closed_at' => UserRef::iso($last->closed_at),
                'sales_amount' => (int) ($lastSales->total ?? 0),
                'receipts_count' => (int) ($lastSales->n ?? 0),
                'counted_cash_amount' => (int) $last->counted_cash_amount,
                'variance_amount' => (int) $last->variance_amount,
                'banked_amount' => (int) $last->banked_amount,
                'left_in_drawer_amount' => (int) $last->left_in_drawer_amount,
            ],
        ];
    }

    /** @return array<string, mixed> PosSession */
    public static function session(PosSession $session): array
    {
        $session->loadMissing(['register', 'location', 'openedBy', 'closedBy']);

        return [
            'id' => $session->id,
            'register' => [
                'id' => $session->register_id,
                'name' => (string) $session->register?->name,
                'location' => ['id' => $session->location_id, 'name' => (string) $session->location?->name],
            ],
            'status' => $session->status,
            'currency' => $session->currency,
            'opened_at' => UserRef::iso($session->opened_at),
            'opened_by' => UserRef::of($session->openedBy),
            'opening_cash_amount' => (int) $session->opening_cash_amount,
            'opening_counts' => self::counts($session->opening_counts),
            'closed_at' => UserRef::iso($session->closed_at),
            'closed_by' => UserRef::of($session->closedBy),
            'counted_cash_amount' => $session->counted_cash_amount,
            'closing_counts' => self::counts($session->closing_counts),
            'expected_cash_amount' => $session->expected_cash_amount,
            'variance_amount' => $session->variance_amount,
            'left_in_drawer_amount' => $session->left_in_drawer_amount,
            'banked_amount' => $session->banked_amount,
            'close_note' => $session->close_note,
            'tolerance_amount' => PosSessionService::tolerance(),
            'last_closing_left_amount' => PosSessionService::lastClosingLeft($session->register_id, $session),
            'totals' => PosSessionService::totals($session),
            'revision' => (int) $session->revision,
        ];
    }

    /**
     * PosCatalogItem (§5.3): the product with its enabled variants and `available` at the register location (null =
     * untracked).
     *
     * @param  array<string, int>  $available  variant id → on_hand − committed at the location
     * @return array<string, mixed>
     */
    public static function catalogItem(Product $product, array $available, string $currency, ?string $onlyVariantId = null): array
    {
        $optionNames = array_map(fn (array $o) => (string) $o['name'], $product->options ?? []);
        $image = $product->images->first()?->media;
        $variants = [];
        foreach ($product->variants as $variant) {
            /** @var ProductVariant $variant */
            if (! $variant->is_enabled || ($onlyVariantId !== null && $variant->id !== $onlyVariantId)) {
                continue;
            }
            $values = $variant->optionValues(count($optionNames));
            $options = [];
            foreach ($optionNames as $i => $name) {
                $options[] = ['name' => $name, 'value' => (string) ($values[$i] ?? '')];
            }
            $variants[] = [
                'id' => $variant->id,
                'title' => $values !== [] ? implode(' · ', $values) : (string) $variant->title,
                'options' => $options,
                'sku' => $variant->sku,
                'barcode' => $variant->barcode,
                'price_amount' => (int) $variant->price_amount,
                'compare_at_amount' => $variant->compare_at_amount !== null && (int) $variant->compare_at_amount > (int) $variant->price_amount ? (int) $variant->compare_at_amount : null,
                'available' => $variant->track_inventory ? ($available[$variant->id] ?? 0) : null,
            ];
        }

        return [
            'product_id' => $product->id,
            'name' => $product->name,
            'image_url' => MediaPresenter::ref($image)['url'] ?? null,
            'currency' => $currency,
            'variants' => $variants,
        ];
    }

    /** @return array<string, mixed> PosSale */
    public static function sale(PosSale $sale, Store $store, ?PermissionSet $permissions): array
    {
        /** @var Order $order */
        $order = Order::query()->whereKey($sale->order_id)->firstOrFail();
        $sale->loadMissing(['register', 'cashier']);
        $charges = PosReceipts::charges($order);
        $cashier = $sale->cashier instanceof User ? (string) $sale->cashier->name : '';
        $register = (string) $sale->register?->name;
        $full = OrderPresenter::full($order, $permissions);

        return [
            'id' => $sale->id,
            'order_id' => $order->id,
            'number' => $order->number,
            'placed_at' => UserRef::iso($order->placed_at),
            'register_name' => $register,
            'cashier_name' => $cashier,
            'customer_name' => trim($order->customer_phone) === '' ? null : $order->customer_name,
            'items_count' => (int) $order->items->sum('quantity'),
            'paid_by' => PosReceipts::paidBy($charges),
            'total_amount' => (int) $order->total_amount,
            'refunded_amount' => (int) $order->refunded_amount,
            'currency' => $order->currency,
            'order' => $full,
            'session_id' => $sale->session_id,
            'tendered_cash_amount' => $sale->tendered_cash_amount,
            'change_amount' => (int) $sale->change_amount,
            'sms_receipt_status' => PosReceipts::smsStatus($sale, $order),
            'receipt' => PosReceipts::receipt($sale, $order, $store, $charges, $cashier, $register),
        ];
    }

    /** @param array<array-key, int>|null $counts @return array<string, int>|object|null JSON object (never a list) */
    private static function counts(?array $counts): array|object|null
    {
        return $counts === null ? null : (object) PosMoney::normaliseCounts($counts);
    }
}
