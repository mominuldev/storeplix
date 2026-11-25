<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\Models\DocumentTemplate;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Inventory\Models\Location;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Support\Collection;

/**
 * Receipts of till sales (PHASE-8-8D §7, P88D-11, P88D-12): the PosReceipt JSON the SPA prints at 80 mm, built with the
 * store's `receipt_80mm` template config (language, logo, BIN, SKU, footer) and tax settings (included VAT, P88D-8);
 * the SMS receipt variables; and the SMS receipt status read from the order timeline.
 */
final class PosReceipts
{
    public const METHOD_LABELS = [
        'en' => ['cash' => 'Cash', 'bkash_personal' => 'bKash', 'card' => 'Card'],
        'bn' => ['cash' => 'নগদ', 'bkash_personal' => 'বিকাশ', 'card' => 'কার্ড'],
    ];

    /** @return array<string, mixed> normalised receipt_80mm template config */
    public static function template(string $storeId): array
    {
        $config = DocumentTemplate::query()->where('store_id', $storeId)->where('kind', 'receipt_80mm')->value('config');

        return TemplateConfig::normalise('receipt_80mm', is_array($config) ? $config : (is_string($config) ? json_decode($config, true) : null));
    }

    /** @return Collection<int, Payment> the sale's till charges, oldest first */
    public static function charges(Order $order): Collection
    {
        return Payment::query()->where('order_id', $order->id)->where('type', Payment::TYPE_CHARGE)
            ->whereNotNull('pos_session_id')->orderBy('created_at')->orderBy('id')->get();
    }

    /** PosPaidBy: the one method, or `split`. @param Collection<int, Payment> $charges */
    public static function paidBy(Collection $charges): string
    {
        $methods = $charges->pluck('method')->unique()->values();

        return $charges->count() > 1 ? 'split' : (string) ($methods->first() ?? 'cash');
    }

    /**
     * PosReceipt (§7).
     *
     * @param  Collection<int, Payment>  $charges
     * @return array<string, mixed>
     */
    public static function receipt(PosSale $sale, Order $order, Store $store, Collection $charges, string $cashierName, string $registerName): array
    {
        $config = self::template($store->id);
        $settings = StoreSetting::query()->where('store_id', $store->id)->with('logo')->first();
        $location = Location::query()->whereKey($sale->location_id)->first();
        $address = $location?->address;
        if ($address === null || trim($address) === '') {
            $address = PickupLocation::query()->where('store_id', $store->id)->orderByDesc('is_default')->orderBy('created_at')->value('address_line');
        }
        $phone = $settings?->contact_phone;
        $items = $order->relationLoaded('items') ? $order->items : $order->items()->get();
        $walkIn = trim($order->customer_phone) === '';

        return [
            'language' => $config['language'],
            'shop' => [
                'name' => $store->name,
                'address' => $address !== null && trim((string) $address) !== '' ? (string) $address : null,
                'phone' => $phone !== null && $phone !== '' ? DocumentRenderer::phone((string) $phone) : null,
                'bin' => $config['show_bin'] && $settings?->tax_bin ? (string) $settings->tax_bin : null,
                'logo_url' => $config['show_logo'] ? MediaPresenter::url($settings?->logo, ['w320']) : null,
            ],
            'number' => $order->number,
            'placed_at' => UserRef::iso($order->placed_at),
            'cashier_name' => $cashierName,
            'register_name' => $registerName,
            'customer' => $walkIn ? null : ['name' => $order->customer_name, 'phone' => DocumentRenderer::phone($order->customer_phone)],
            'lines' => $items->map(fn (OrderItem $i) => [
                'name' => $i->product_name,
                'variant_title' => $i->variant_title !== '' && $i->variant_title !== 'Default' ? $i->variant_title : null,
                'sku' => $config['show_sku'] ? $i->sku : null,
                'quantity' => (int) $i->quantity,
                'line_total_amount' => (int) $i->total_amount,
            ])->values()->all(),
            'subtotal_amount' => (int) $order->subtotal_amount,
            'discount_amount' => (int) $order->discount_amount,
            'coupon_code' => $order->coupon_code,
            'vat' => PosPricing::vat($store->id, (int) $order->total_amount),
            'total_amount' => (int) $order->total_amount,
            'payments' => $charges->map(fn (Payment $p) => ['method' => (string) $p->method, 'amount' => (int) $p->amount])->values()->all(),
            'tendered_cash_amount' => $sale->tendered_cash_amount,
            'change_amount' => (int) $sale->change_amount,
            'footer_text' => $config['footer_text'],
            'currency' => $order->currency,
        ];
    }

    /**
     * PosSmsReceiptStatus: the newest `pos_receipt` notification on the timeline (sent / failed — a skipped send, e.g.
     * allowance used, counts as failed); none yet → queued when it was asked for; else no_phone / not_requested.
     */
    public static function smsStatus(PosSale $sale, Order $order): string
    {
        $latest = OrderEvent::query()->where('order_id', $order->id)->where('type', 'notification')
            ->orderByDesc('created_at')->orderByDesc('id')->get()
            ->first(fn (OrderEvent $e) => ($e->meta['channel'] ?? null) === 'sms' && ($e->meta['event'] ?? null) === SmsTemplates::POS_RECEIPT);
        if ($latest !== null) {
            return ($latest->meta['status'] ?? null) === 'sent' ? 'sent' : 'failed';
        }
        if (trim($order->customer_phone) === '') {
            return 'no_phone';
        }

        return $sale->sms_receipt ? 'queued' : 'not_requested';
    }

    /**
     * SMS receipt variables (§7): method label(s) and the template footer as one clean line (cut first when the text
     * is over 3 segments, SmsTemplates::render).
     *
     * @return array<string, string>
     */
    public static function smsVars(Order $order, string $language): array
    {
        $labels = self::METHOD_LABELS[$language === 'en' ? 'en' : 'bn'];
        $methods = self::charges($order)->pluck('method')->unique()->map(fn ($m) => $labels[$m] ?? (string) $m)->values()->all();
        $footer = self::template($order->store_id)['footer_text'];

        return [
            'method' => implode(' + ', $methods),
            'footer' => $footer !== null ? SmsTemplates::clean($footer, 120) : '',
        ];
    }
}
