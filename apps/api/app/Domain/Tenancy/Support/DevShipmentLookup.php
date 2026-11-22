<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

use App\Domain\Orders\Models\Shipment;

/**
 * TESTING-ONLY pre-tenant lookup for `POST /dev/shipments/{shipment}/advance` (COURIERS_FAKE, never in production):
 * shipment id → owning tenant. Platform connection (§2.4); the caller then works inside TenantContext::run().
 */
class DevShipmentLookup
{
    /** @return array{tenant_id: string, store_id: string}|null */
    public function shipmentOwner(string $shipmentId): ?array
    {
        if (app()->environment('production') || ! config('couriers.fake')) {
            return null;
        }
        $id = strtolower($shipmentId);
        if (preg_match('/^[0-9a-hjkmnp-tv-z]{26}$/', $id) !== 1) {
            return null;
        }
        // cross-tenant: dev-only lookup of a shipment's owner (fake couriers; route not registered in production).
        $row = Shipment::withoutTenancy()->whereKey($id)->first(['tenant_id', 'store_id']);

        return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id];
    }
}
