<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Http\ApiException;

/**
 * couriers:fake-advance and `POST /dev/shipments/{shipment}/advance` (COURIERS_FAKE only, PHASE-5B §15): moves the
 * fake courier's parcel, then delivers the change exactly like the real courier would — a signed webhook through
 * parseWebhook → webhook_events → ProcessCourierWebhook (run inline, money statuses re-queried) for couriers with
 * webhooks, or a poll (ShipmentSync::refresh) for RedX, which has none.
 */
final class FakeShipmentAdvancer
{
    /** Normalised courier words + `settled` (COD paid out). */
    public const STATUSES = [
        'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'delivery_failed', 'delivered',
        'partially_delivered', 'returning', 'returned', 'cancelled', 'settled',
    ];

    public function __construct(
        private readonly CourierManager $couriers,
        private readonly ShipmentSync $sync,
        private readonly CourierWebhooks $webhooks,
    ) {}

    public function advance(Shipment $shipment, string $status, ?int $codCollectedAmount = null): Shipment
    {
        $fake = $shipment->provider !== Shipment::MANUAL ? $this->couriers->fake($shipment->provider) : null;
        if (! $fake instanceof FakeCourier) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if ($shipment->consignment_id === null) {
            throw new ApiException(409, 'invalid_state_transition', 'This parcel is not booked with the courier yet.');
        }
        $fake->advance($shipment, $status, $codCollectedAmount);
        $account = $this->sync->account($shipment);
        $secret = $fake->supportsWebhooks() ? $account->webhookSecret() : null;

        if ($secret === null) {
            return $this->sync->refresh($shipment, 'poll');
        }
        $payload = $fake->webhookPayload($shipment->refresh());
        $data = $fake->parseWebhook($payload, FakeCourier::webhookHeaders($shipment->provider, $secret), $account);
        if ($data !== null) {
            $this->webhooks->store(['tenant_id' => $shipment->tenant_id, 'store_id' => $shipment->store_id, 'account_id' => $account->id],
                $shipment->provider, $data, $payload, inline: true);
        }

        return $shipment->refresh();
    }
}
