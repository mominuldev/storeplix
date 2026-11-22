<?php

namespace App\Domain\Shipping;

use App\Domain\Geo\BdGeo;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;

/** ShippingZone / PickupLocation / ShippingSettings payloads (@storeplix/types). */
final class ShippingPresenter
{
    /**
     * @param  list<object{district_code: string, thana_code: string}>  $areas
     * @return array<string, mixed>
     */
    public static function zone(ShippingZone $zone, array $areas): array
    {
        $geo = app(BdGeo::class);
        $out = [];
        foreach ($areas as $area) {
            $district = $geo->district($area->district_code);
            $thana = $area->thana_code !== '' ? $geo->thana($area->thana_code) : null;
            $out[] = [
                'district_code' => $area->district_code,
                'thana_code' => $area->thana_code !== '' ? $area->thana_code : null,
                'label' => $thana !== null
                    ? $thana['name'].', '.($district['name'] ?? $area->district_code)
                    : ($district['name'] ?? $area->district_code).' (whole district)',
            ];
        }

        return [
            'id' => $zone->id,
            'name' => $zone->name,
            'kind' => $zone->kind,
            'charge_amount' => $zone->charge_amount,
            'min_days' => $zone->min_days,
            'max_days' => $zone->max_days,
            'is_active' => $zone->is_active,
            'position' => $zone->position,
            'areas' => $out,
            'area_summary' => $zone->isFallback() ? 'Everywhere else' : self::summary($areas),
        ];
    }

    /**
     * "Dhaka city · 50 thanas", "Gazipur, Narayanganj", "Dhaka · Savar, Gazipur", "+ 2 more".
     *
     * @param  list<object{district_code: string, thana_code: string}>  $areas
     */
    public static function summary(array $areas): string
    {
        if ($areas === []) {
            return 'No areas yet';
        }
        $geo = app(BdGeo::class);
        $groups = [];
        foreach ($areas as $area) {
            $groups[$area->district_code][] = $area->thana_code;
        }
        $parts = [];
        foreach ($groups as $districtCode => $thanas) {
            $name = $geo->district($districtCode)['name'] ?? $districtCode;
            $thanas = array_values(array_filter($thanas, fn ($t) => $t !== ''));
            if ($thanas === []) {
                $parts[] = $name;
            } elseif (count($thanas) === 1) {
                $parts[] = ($geo->thana($thanas[0])['name'] ?? $thanas[0]).', '.$name;
            } else {
                $city = array_filter($thanas, fn ($t) => (bool) ($geo->thana($t)['is_city'] ?? false));
                $parts[] = (count($city) === count($thanas) ? "{$name} city" : $name).' · '.count($thanas).' thanas';
            }
        }
        $shown = array_slice($parts, 0, 3);
        $more = count($parts) - count($shown);

        return implode(', ', $shown).($more > 0 ? " + {$more} more" : '');
    }

    /** @return array<string, mixed> */
    public static function pickup(PickupLocation $location): array
    {
        $geo = app(BdGeo::class);

        return [
            'id' => $location->id,
            'name' => $location->name,
            'contact_name' => $location->contact_name,
            'contact_phone' => $location->contact_phone,
            'district_code' => $location->district_code,
            'thana_code' => $location->thana_code,
            'district' => $geo->district($location->district_code)['name'] ?? $location->district_code,
            'thana' => $geo->thana($location->thana_code)['name'] ?? $location->thana_code,
            'address_line' => $location->address_line,
            'is_default' => $location->is_default,
            'created_at' => UserRef::iso($location->created_at),
            'updated_at' => UserRef::iso($location->updated_at),
        ];
    }
}
