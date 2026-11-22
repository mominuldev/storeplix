<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Controllers;

use App\Domain\Couriers\FakeShipmentAdvancer;
use App\Domain\Couriers\ShipmentPresenter;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\DevShipmentLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * TESTING-ONLY: `POST /api/v1/dev/shipments/{shipment}/advance` `{status, cod_collected_amount?}` (PHASE-5B §15).
 * Registered only outside production and answering 404 unless COURIERS_FAKE=true. Moves the fake courier's parcel and
 * applies the event through the same path as a webhook (store in webhook_events → ProcessCourierWebhook, run inline).
 */
class DevShipmentController
{
    public function __invoke(Request $request, string $shipment, DevShipmentLookup $lookup, TenantContext $context, FakeShipmentAdvancer $advancer): JsonResponse
    {
        abort_if(app()->environment('production') || ! config('couriers.fake'), 404);
        $input = $request->validate([
            'status' => ['required', 'string', Rule::in(FakeShipmentAdvancer::STATUSES)],
            'cod_collected_amount' => ['sometimes', 'nullable', 'integer:strict', 'min:0'],
        ]);
        $owner = $lookup->shipmentOwner($shipment) ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        return $context->run($owner['tenant_id'], function () use ($shipment, $input, $advancer) {
            $row = Shipment::query()->whereKey(strtolower($shipment))->firstOrFail();
            $row = $advancer->advance($row, $input['status'], $input['cod_collected_amount'] ?? null);

            return new JsonResponse(['data' => ShipmentPresenter::shipment($row) + [
                'order_status' => (string) Order::query()->whereKey($row->order_id)->value('status'),
            ]]);
        });
    }
}
