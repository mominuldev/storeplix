<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Catalog\Http\Resources\ProductPresenter;
use App\Domain\Catalog\Models\Product;
use App\Domain\Couriers\ShipmentPresenter;
use App\Domain\Customers\Http\Resources\CustomerPresenter;
use App\Domain\Customers\Models\Customer;
use App\Domain\Inventory\Http\Resources\InventoryPresenter;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Returns\ReturnPresenter;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * §4.2 payloads (version 2026-12-01). `data.object` is built with the same presenters as the merchant / external API
 * GET of the subject (P84-12), with no member permissions: costs are never included. Call inside the tenant context,
 * after commit (the subject is re-read so the snapshot is what was committed).
 */
final class WebhookPayloads
{
    public const API_VERSION = '2026-12-01';

    /**
     * The subject's object and a short label (order number, product name …); null when the row is gone.
     *
     * @return array{object: array<string, mixed>, label: string|null}|null
     */
    public function subject(string $subjectType, string $id): ?array
    {
        $result = match ($subjectType) {
            'order' => ($o = Order::query()->find($id)) ? [OrderPresenter::full($o, null), $o->number] : null,
            'shipment' => ($s = Shipment::query()->with('order')->find($id)) ? [ShipmentPresenter::summary($s), $s->order?->number] : null,
            'return_request' => ($r = ReturnRequest::query()->with(ReturnPresenter::WITH)->find($id)) ? [ReturnPresenter::full($r), $r->number] : null,
            'product' => ($p = Product::query()->with(ProductPresenter::with(true))->find($id)) ? [ProductPresenter::full($p, false), $p->name] : null,
            'inventory' => $this->inventory($id),
            'customer' => $this->customer($id),
            default => null,
        };

        return $result === null ? null : ['object' => $result[0], 'label' => self::label($result[1])];
    }

    /**
     * The full §4.2 body. Bodies above the size cap carry the subject ids only, with `truncated: true`.
     *
     * @param  array<string, mixed>  $object
     * @return array<string, mixed>
     */
    public static function envelope(string $eventId, WebhookEventType $type, string $storeId, array $object, ?Carbon $at = null): array
    {
        $body = [
            'id' => $eventId,
            'type' => $type->value,
            'api_version' => self::API_VERSION,
            'created_at' => ($at ?? now())->toIso8601ZuluString(),
            'store_id' => $storeId,
            'data' => ['object' => $object === [] ? (object) [] : $object],
        ];
        if (strlen((string) json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) > (int) config('webhooks_out.max_body_bytes', 262144)) {
            $body['data']['object'] = array_filter([
                'id' => $object['id'] ?? null,
                'variant_id' => $object['variant_id'] ?? null,
                'number' => $object['number'] ?? null,
                'truncated' => true,
            ], fn ($v) => $v !== null);
        }

        return $body;
    }

    public static function label(?string $value): ?string
    {
        return $value === null || $value === '' ? null : Str::limit($value, 40, '');
    }

    /** @return array{0: array<string, mixed>, 1: string|null}|null */
    private function inventory(string $id): ?array
    {
        $inventory = Inventory::query()->with('location')->find($id);
        $variant = $inventory?->variant()->with(['product.images.media', 'inventories'])->first();
        if ($variant === null || $variant->product === null) {
            return null;
        }

        // PHASE-8-8C P88C-15: the numbers of that location's row, plus the location.
        return [InventoryPresenter::item($variant, false, $inventory->location_id) + ['location' => [
            'id' => $inventory->location_id,
            'name' => (string) $inventory->location?->name,
        ]], $variant->sku ?? $variant->product->name];
    }

    /** @return array{0: array<string, mixed>, 1: string|null}|null */
    private function customer(string $id): ?array
    {
        $customer = Customer::query()->with('createdBy')->withCount('notes')->find($id);
        if ($customer === null) {
            return null;
        }
        $currency = (string) (Store::query()->whereKey($customer->store_id)->value('currency') ?: 'BDT');

        return [CustomerPresenter::customer($customer, $currency, (int) $customer->notes_count), $customer->name];
    }
}
