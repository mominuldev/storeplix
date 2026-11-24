<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Documents\Drivers\DocumentDriver;
use App\Domain\Documents\Drivers\DocumentRenderFailed;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\PurchaseOrderItem;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Carbon\CarbonImmutable;

/**
 * PHASE-8-8B §5.6 / P88B-14: the PO PDF through the 5b-4 renderer (pattern BillingInvoicePdf; A4, English), rendered
 * on demand and never stored. With DOCUMENTS_DRIVER=html (local/CI) the "PDF" is the rendered HTML.
 */
final class PurchaseOrderPdf
{
    public function __construct(private readonly DocumentDriver $driver) {}

    /** @return array{bytes: string, mime: string, extension: string} */
    public function render(Store $store, PurchaseOrder $po): array
    {
        try {
            $file = $this->driver->render($this->html($store, $po, fonts: config('documents.driver') === 'gotenberg'), 'invoice_a4');
        } catch (DocumentRenderFailed) {
            throw new ApiException(502, 'provider_unavailable', 'The PDF service is not available. Try again in a moment.');
        }

        return ['bytes' => $file['bytes'], 'mime' => $file['mime'], 'extension' => $file['extension']];
    }

    public function html(Store $store, PurchaseOrder $po, bool $fonts = false): string
    {
        $po->loadMissing(['supplier', 'location', 'items.variant.product']);
        $tz = PurchaseHistory::tz($store);
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();
        $address = array_filter((array) ($settings?->business_address ?? []), fn ($v) => is_string($v) && $v !== '');
        $date = fn (?string $d) => $d === null ? null : CarbonImmutable::parse($d)->format('j M Y');
        $money = fn (int $amount) => $po->currency === 'BDT' ? Money::bdt($amount) : $po->currency.' '.Money::plain($amount);
        $supplier = $po->supplier;

        return view('documents.purchase_order', [
            'fonts' => $fonts,
            'number' => $po->number,
            'status' => str_replace('_', ' ', $po->status),
            'store' => ['name' => $store->name, 'address' => implode(', ', $address), 'phone' => $settings?->contact_phone],
            'supplier' => [
                'name' => $supplier->name,
                'contact' => $supplier->contact_name,
                'phone' => $supplier->phone !== null ? '0'.substr($supplier->phone, 3) : null,
                'city' => $supplier->city,
            ],
            'created' => CarbonImmutable::parse($po->created_at)->setTimezone($tz)->format('j M Y'),
            'expected' => $date($po->expectedOn()),
            'lines' => $po->items->map(fn (PurchaseOrderItem $i) => [
                'product' => (string) ($i->variant?->product?->name ?? ''),
                'variant' => $i->variant !== null && ! $i->variant->is_default ? (string) $i->variant->title : '',
                'sku' => $i->variant?->sku,
                'quantity' => $i->quantity_ordered,
                'unit' => $money($i->unit_cost_amount),
                'total' => $money($i->lineValue()),
            ])->all(),
            'subtotal' => $money($po->subtotal_amount),
            'shipping' => $po->shipping_amount > 0 ? $money($po->shipping_amount) : null,
            'discount' => $po->discount_amount > 0 ? $money($po->discount_amount) : null,
            'total' => $money($po->total_amount),
            'notes' => $po->notes,
            // PHASE-8-8C §6: "Receive at {location}" only when the store has more than one active location.
            'receiveAt' => Locations::activeCount($store->id) > 1 ? $po->location?->name : null,
        ])->render();
    }
}
