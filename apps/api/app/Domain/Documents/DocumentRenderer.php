<?php

namespace App\Domain\Documents;

use App\Domain\Geo\BdGeo;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Support\Money;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Throwable;

/**
 * DocumentRenderer (PHASE-5B-CONTRACT §7): orders + template config → one HTML document (Blade view
 * `documents/{kind}`), which a driver turns into the stored file. Everything a template prints is prepared here as
 * plain strings (escaped by Blade `{{ }}`); barcodes, QR and the logo are data URIs; fonts are file names that the
 * Gotenberg request carries alongside index.html (no remote URL anywhere, S34).
 */
class DocumentRenderer
{
    /** Font files sent with every Gotenberg request (P5B-51). */
    public const FONTS = ['NotoSansBengali-Regular.ttf', 'NotoSansBengali-Bold.ttf', 'Inter-Regular.woff2', 'Inter-Bold.woff2'];

    public function __construct(
        private readonly BdGeo $geo,
        private readonly TenantStorage $storage,
    ) {}

    /**
     * @param  Collection<int, Order>  $orders  with `items` loaded (or loadable)
     * @param  array<string, mixed>  $config  normalised DocumentTemplateConfig
     * @param  bool  $embedFonts  true for PDF rendering (font files next to index.html); false for previews and the
     *                            `html` driver (the browser's own fonts shape Bangla)
     */
    public function html(string $kind, Collection $orders, Store $store, array $config, string $language, bool $embedFonts): string
    {
        $language = $language === 'bn' ? 'bn' : 'en';
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();
        $shop = $this->shop($store, $settings, $config);
        $docs = $orders->map(fn (Order $o) => $this->order($o, $store, $settings, $config, $language))->values()->all();
        $t = fn (string $key, array $replace = []) => trans('documents.'.$key, $replace, $language);

        return view('documents.'.$kind, [
            'kind' => $kind,
            'paper' => TemplateConfig::PAPER[$kind],
            'config' => $config,
            'shop' => $shop,
            'docs' => $docs,
            'language' => $language,
            't' => $t,
            'fonts' => $embedFonts,
            'footer' => $config['footer_text'] ?? ($settings?->invoice_footer !== null ? DocumentText::clean($settings->invoice_footer, 300) : null),
        ])->render();
    }

    /** Expected page count of the HTML layout (the `html` driver can't measure; Gotenberg output is counted). */
    public static function pages(string $kind, int $orders): int
    {
        return match ($kind) {
            'invoice_a5_two_up' => (int) ceil($orders / 2),
            'receipt_80mm' => 1,
            default => $orders,
        };
    }

    /** Absolute paths of the font files (resources/fonts, OFL; provenance in the *-OFL.txt files). */
    public static function fontPaths(): array
    {
        return array_map(fn (string $f) => resource_path('fonts/'.$f), self::FONTS);
    }

    /**
     * Sample order for the Live preview when no order is chosen (never saved).
     */
    public function sample(Store $store): Order
    {
        $order = new Order;
        $order->forceFill([
            'id' => '01sampl0000000000000000000', 'store_id' => $store->id, 'number' => 'SP-1042', 'sequence' => 1042,
            'status' => Order::CONFIRMED, 'payment_status' => 'unpaid', 'payment_method' => 'cod', 'channel' => 'facebook', 'created_via' => 'dashboard',
            'customer_name' => 'রহিম উদ্দিন', 'customer_phone' => '8801711000000', 'district_code' => 'dhaka',
            'shipping_address' => ['district_code' => 'dhaka', 'district' => 'Dhaka', 'thana_code' => 'dhaka-mirpur', 'thana' => 'Mirpur', 'address_line' => 'বাড়ি ১২, রোড ৩, মিরপুর ১০', 'area' => null, 'landmark' => null],
            'currency' => 'BDT', 'subtotal_amount' => 245000, 'discount_amount' => 10000, 'shipping_amount' => 7000, 'shipping_discount_amount' => 0, 'tax_amount' => 0,
            'total_amount' => 242000, 'paid_amount' => 0, 'refunded_amount' => 0, 'coupon_code' => 'WELCOME10', 'placed_at' => now(), 'tags' => [],
        ]);
        $lines = [['Cotton Panjabi', 'M / Blue', 'PNJ-M-BL', 1, 150000], ['Plush Elephant', 'Grey', 'PLU-GR', 1, 95000]];
        $items = new \Illuminate\Database\Eloquent\Collection;
        foreach ($lines as $i => [$name, $variant, $sku, $qty, $price]) {
            $item = new OrderItem;
            $item->forceFill(['id' => 'sample'.$i, 'product_name' => $name, 'variant_title' => $variant, 'sku' => $sku, 'quantity' => $qty,
                'unit_price_amount' => $price, 'subtotal_amount' => $price * $qty, 'discount_amount' => 0, 'total_amount' => $price * $qty, 'position' => $i]);
            $items->push($item);
        }
        $order->setRelation('items', $items);
        $order->setRelation('shipment', null);

        return $order;
    }

    /** @param array<string, mixed> $config @return array<string, mixed> */
    private function shop(Store $store, ?StoreSetting $settings, array $config): array
    {
        $pickup = PickupLocation::query()->where('store_id', $store->id)->orderByDesc('is_default')->orderBy('created_at')->first();
        $address = $pickup !== null ? $this->addressLine($pickup->address_line, $pickup->thana_code, $pickup->district_code) : null;
        $phone = $pickup?->contact_phone ?? $settings?->contact_phone;

        return [
            'name' => DocumentText::clean($store->name, 80),
            'logo' => $config['show_logo'] ? $this->logo($settings) : null,
            'address' => $address,
            'phone' => $phone !== null ? self::phone($phone) : null,
            'bin' => $config['show_bin'] && $settings?->tax_bin ? DocumentText::clean($settings->tax_bin, 16) : null,
            'host' => $store->primaryDomain?->hostname,
        ];
    }

    /** P5B-58: the store's logo read from storage, inlined (png / jpeg / webp only, size-capped). */
    private function logo(?StoreSetting $settings): ?string
    {
        if ($settings?->logo_media_id === null) {
            return null;
        }
        /** @var Media|null $media */
        $media = Media::query()->whereKey($settings->logo_media_id)->where('status', Media::READY)->first();
        if ($media === null || ! in_array($media->mime, ['image/png', 'image/jpeg', 'image/webp'], true) || $media->size_bytes > (int) config('documents.logo_max_bytes')) {
            return null;
        }
        try {
            $bytes = $this->storage->disk($media->disk)->get($media->path);
        } catch (Throwable) {
            return null;
        }

        return $bytes === null ? null : 'data:'.$media->mime.';base64,'.base64_encode($bytes);
    }

    /** @param array<string, mixed> $config @return array<string, mixed> */
    private function order(Order $o, Store $store, ?StoreSetting $settings, array $config, string $language): array
    {
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $items = $o->relationLoaded('items') ? $o->items : $o->items()->get();
        $shipment = $o->relationLoaded('shipment') ? $o->shipment : Shipment::query()->where('order_id', $o->id)->where('status', '<>', 'cancelled')->first();
        $a = $o->shipping_address ?? [];
        $consignment = $shipment?->getAttribute('consignment_id') ?? $shipment?->tracking_code;
        $code = $consignment !== null && $consignment !== '' ? (string) $consignment : $o->number;
        $due = $o->dueAmount();
        $vat = null;
        if ($settings?->tax_display === 'included' && (int) $settings->tax_rate_bps > 0) {
            $rate = (int) $settings->tax_rate_bps;
            $amount = intdiv($o->total_amount * $rate, 10000 + $rate); // P5B-56: floor(total × rate / (10 000 + rate))
            $vat = trans('documents.vat_included', ['rate' => rtrim(rtrim(number_format($rate / 100, 2, '.', ''), '0'), '.'), 'amount' => Money::bdt($amount)], $language);
        }
        $lines = $items->map(fn (OrderItem $i) => [
            'name' => DocumentText::clean($i->product_name, 120),
            'variant' => DocumentText::clean($i->variant_title, 80),
            'sku' => $config['show_sku'] && $i->sku ? DocumentText::clean($i->sku, 64) : null,
            'qty' => $i->quantity,
            'unit' => Money::bdt($i->unit_price_amount),
            'total' => Money::bdt($i->total_amount),
        ])->values()->all();
        $summary = implode(', ', array_map(fn ($l) => $l['qty'].' × '.$l['name'].($l['variant'] !== '' && $l['variant'] !== 'Default' ? ' ('.$l['variant'].')' : ''), $lines));
        $courier = $shipment === null ? null : ($shipment->provider !== 'manual' ? ucfirst($shipment->provider) : DocumentText::clean((string) $shipment->carrier_name, 40));
        $weight = $shipment?->getAttribute('weight_grams');

        return [
            'number' => $o->number,
            'date' => Carbon::parse($o->placed_at)->setTimezone($tz)->format('d M Y'),
            'name' => DocumentText::clean($o->customer_name, 120),
            'phone' => self::phone($o->customer_phone),
            'address' => $this->addressLine((string) ($a['address_line'] ?? ''), (string) ($a['thana_code'] ?? ''), (string) ($a['district_code'] ?? ''), $a),
            'district' => DocumentText::clean((string) ($a['district'] ?? ''), 60),
            'thana' => DocumentText::clean((string) ($a['thana'] ?? ''), 60),
            'lines' => $lines,
            'items_summary' => mb_strimwidth($summary, 0, 160, '…'),
            'subtotal' => Money::bdt($o->subtotal_amount),
            'discount' => $o->discount_amount > 0 ? '− '.Money::bdt($o->discount_amount) : null,
            'coupon' => $o->coupon_code,
            'delivery' => Money::bdt($o->shipping_amount),
            'vat' => $vat,
            'total' => Money::bdt($o->total_amount),
            'paid' => $o->paid_amount > 0 ? Money::bdt($o->paid_amount - $o->refunded_amount) : null,
            'due_amount' => $due,
            'due' => Money::bdt($due),
            'method' => $o->payment_method === 'cod' && $o->paid_amount === 0 ? 'cod' : 'online',
            'courier' => $courier,
            'consignment' => $consignment !== null ? DocumentText::clean((string) $consignment, 64) : null,
            'barcode' => Codes::code128($code),
            'barcode_text' => $code,
            'qr' => $store->primaryDomain?->hostname ? Codes::qr('https://'.$store->primaryDomain->hostname.'/track') : null,
            'weight' => $weight ? number_format($weight / 1000, 2).' kg' : null,
            'note' => $o->customer_note !== null ? DocumentText::clean($o->customer_note, 300) : null,
        ];
    }

    /** "House 12, Road 7A, Dhanmondi, Dhaka" from the snapshot (names) or the geo codes. @param array<string, mixed> $snapshot */
    private function addressLine(string $line, string $thanaCode, string $districtCode, array $snapshot = []): string
    {
        $thana = $snapshot['thana'] ?? $this->geo->thana($thanaCode)['name'] ?? '';
        $district = $snapshot['district'] ?? $this->geo->district($districtCode)['name'] ?? '';
        $parts = array_filter([$line, $snapshot['area'] ?? null, $snapshot['landmark'] ?? null, $thana, $district], fn ($p) => is_string($p) && trim($p) !== '');

        return DocumentText::clean(implode(', ', array_unique($parts)), 300);
    }

    /** 8801711000000 / +8801711000000 → 01711-000000 (Latin digits, Q51). */
    public static function phone(string $phone): string
    {
        $digits = (string) preg_replace('/\D/', '', $phone);
        if (str_starts_with($digits, '880') && strlen($digits) === 13) {
            $digits = substr($digits, 2);
        }

        return strlen($digits) === 11 ? substr($digits, 0, 5).'-'.substr($digits, 5) : $digits;
    }
}
