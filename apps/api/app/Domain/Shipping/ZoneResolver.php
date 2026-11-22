<?php

namespace App\Domain\Shipping;

use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Support\Facades\DB;

/**
 * P5-7 zone resolution: active zone holding the thana → active zone holding the whole district → the fallback zone.
 * P5-9: free delivery when the merchandise subtotal after discount reaches the store-wide threshold.
 */
class ZoneResolver
{
    public function resolve(string $storeId, string $districtCode, string $thanaCode): ?ShippingZone
    {
        $matches = DB::table('shipping_zone_areas')
            ->join('shipping_zones', 'shipping_zones.id', '=', 'shipping_zone_areas.zone_id')
            ->where('shipping_zone_areas.store_id', $storeId)
            ->where('shipping_zones.store_id', $storeId)
            ->where('shipping_zones.is_active', true)
            ->where('shipping_zone_areas.district_code', $districtCode)
            ->whereIn('shipping_zone_areas.thana_code', [$thanaCode, ''])
            ->pluck('shipping_zone_areas.zone_id', 'shipping_zone_areas.thana_code');

        $zoneId = $matches[$thanaCode] ?? $matches[''] ?? null;
        if ($zoneId !== null) {
            return ShippingZone::query()->where('store_id', $storeId)->whereKey($zoneId)->first();
        }

        return ShippingZone::query()->where('store_id', $storeId)->where('kind', ShippingZone::FALLBACK)->first();
    }

    /**
     * ShippingQuote (§6). Without any zone (store never saved its delivery charges) delivery is free, so an order is
     * never blocked; such stores can't publish (launch checklist).
     *
     * @return array{zone_id: string, zone_name: string, min_days: int, max_days: int, charge_amount: int, amount: int, is_free: bool}|null
     */
    public function quote(string $storeId, string $districtCode, string $thanaCode, int $merchandiseAfterDiscount, ?int $freeOver = null): ?array
    {
        $zone = $this->resolve($storeId, $districtCode, $thanaCode);
        if ($zone === null) {
            return null;
        }
        $freeOver ??= self::freeOver($storeId);
        $free = $freeOver !== null && $merchandiseAfterDiscount >= $freeOver;

        return [
            'zone_id' => $zone->id,
            'zone_name' => $zone->name,
            'min_days' => $zone->min_days,
            'max_days' => $zone->max_days,
            'charge_amount' => $zone->charge_amount,
            'amount' => $free ? 0 : $zone->charge_amount,
            'is_free' => $free || $zone->charge_amount === 0,
        ];
    }

    public static function freeOver(string $storeId): ?int
    {
        $value = StoreSetting::query()->where('store_id', $storeId)->value('free_delivery_over_amount');

        return $value === null ? null : (int) $value;
    }
}
