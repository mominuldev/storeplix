<?php

namespace App\Domain\Shipping;

use App\Domain\Geo\BdGeo;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Shipping\Models\ShippingZoneArea;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * §3.5 shipping settings. Zones are saved as a full replacement in one transaction (ids keep rows, missing custom
 * zones are deleted, exactly one fallback). P5-8 defaults: "Inside Dhaka" = Dhaka city thanas ৳ 70 / 1–2 days,
 * fallback "Outside Dhaka" ৳ 130 / 2–4 days.
 */
class ShippingService
{
    public const DEFAULT_INSIDE = ['name' => 'Inside Dhaka', 'charge_amount' => 7000, 'min_days' => 1, 'max_days' => 2];

    public const DEFAULT_FALLBACK = ['name' => 'Outside Dhaka', 'charge_amount' => 13000, 'min_days' => 2, 'max_days' => 4];

    public function __construct(
        private readonly BdGeo $geo,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array{zones: list<array<string, mixed>>, pickup_locations: list<array<string, mixed>>, free_delivery_over_amount: int|null, configured: bool} */
    public function settings(Store $store): array
    {
        $zones = $this->zones($store->id);
        $areas = DB::table('shipping_zone_areas')->where('store_id', $store->id)
            ->orderBy('district_code')->orderBy('thana_code')->get(['zone_id', 'district_code', 'thana_code'])->groupBy('zone_id');

        return [
            'zones' => array_map(fn (ShippingZone $z) => ShippingPresenter::zone($z, ($areas[$z->id] ?? collect())->all()), $zones),
            'pickup_locations' => PickupLocation::query()->where('store_id', $store->id)->orderByDesc('is_default')->orderBy('created_at')->orderBy('id')
                ->get()->map(fn (PickupLocation $l) => ShippingPresenter::pickup($l))->all(),
            'free_delivery_over_amount' => ZoneResolver::freeOver($store->id),
            'configured' => $this->configured($store->id),
        ];
    }

    public function configured(string $storeId): bool
    {
        return ShippingZone::query()->where('store_id', $storeId)->where('kind', ShippingZone::FALLBACK)->exists();
    }

    /** @return list<ShippingZone> custom zones by position, fallback last */
    public function zones(string $storeId, bool $activeOnly = false): array
    {
        return ShippingZone::query()->where('store_id', $storeId)
            ->when($activeOnly, fn ($q) => $q->where('is_active', true))
            ->orderByRaw("CASE WHEN kind = 'fallback' THEN 1 ELSE 0 END")->orderBy('position')->orderBy('id')
            ->get()->all();
    }

    /**
     * PUT /stores/{store}/shipping (validated shape). Returns the saved settings.
     *
     * @param  array{zones: list<array<string, mixed>>, free_delivery_over_amount?: int|null}  $input
     */
    public function save(Store $store, array $input): void
    {
        $existing = ShippingZone::query()->where('store_id', $store->id)->get()->keyBy('id');
        $fallbacks = array_keys(array_filter($input['zones'], fn ($z) => $z['kind'] === ShippingZone::FALLBACK));
        if (count($fallbacks) !== 1) {
            throw ValidationException::withMessages(['zones' => ['Keep one fallback zone for everywhere else.']]);
        }

        $errors = [];
        $taken = [];
        $plans = [];
        foreach ($input['zones'] as $i => $zone) {
            $id = isset($zone['id']) ? strtolower((string) $zone['id']) : null;
            $row = $id !== null ? ($existing[$id] ?? null) : null;
            if ($id !== null && ($row === null || $row->kind !== $zone['kind'])) {
                $errors["zones.{$i}.id"] = ['Unknown zone.'];

                continue;
            }
            $isFallback = $zone['kind'] === ShippingZone::FALLBACK;
            if ($isFallback && ($zone['areas'] ?? []) !== []) {
                $errors["zones.{$i}.areas"] = ['The fallback zone covers everywhere else, so it has no areas.'];
            }
            if ($isFallback && array_key_exists('is_active', $zone) && $zone['is_active'] === false) {
                $errors["zones.{$i}.is_active"] = ['The fallback zone is always on.'];
            }
            if ((int) $zone['min_days'] > (int) $zone['max_days']) {
                $errors["zones.{$i}.max_days"] = ['Must be at least the minimum days.'];
            }
            $areas = [];
            foreach ($zone['areas'] ?? [] as $j => $area) {
                $district = (string) $area['district_code'];
                $thana = isset($area['thana_code']) && $area['thana_code'] !== null && $area['thana_code'] !== '' ? (string) $area['thana_code'] : '';
                if ($this->geo->district($district) === null) {
                    $errors["zones.{$i}.areas.{$j}.district_code"] = ['Unknown district.'];

                    continue;
                }
                if ($thana !== '' && ! $this->geo->thanaInDistrict($district, $thana)) {
                    $errors["zones.{$i}.areas.{$j}.thana_code"] = ['Unknown thana for this district.'];

                    continue;
                }
                $key = $district.'|'.$thana;
                if (isset($areas[$key])) {
                    continue; // same area twice in one zone
                }
                if (isset($taken[$key])) {
                    $label = $thana !== '' ? $this->geo->thana($thana)['name'] : $this->geo->district($district)['name'];
                    $errors["zones.{$i}.areas.{$j}"] = ["{$label} is already in {$taken[$key]}."];

                    continue;
                }
                $taken[$key] = $zone['name'];
                $areas[$key] = [$district, $thana];
            }
            $plans[] = ['row' => $row, 'input' => $zone, 'areas' => array_values($areas), 'position' => $i];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        DB::transaction(function () use ($store, $input, $plans, $existing) {
            $keep = [];
            foreach ($plans as $plan) {
                $zone = $plan['row'] ?? ($plan['input']['kind'] === ShippingZone::FALLBACK
                    ? ShippingZone::query()->where('store_id', $store->id)->where('kind', ShippingZone::FALLBACK)->first()
                    : null) ?? new ShippingZone;
                $zone->fill([
                    'name' => trim((string) $plan['input']['name']),
                    'kind' => $plan['input']['kind'],
                    'charge_amount' => (int) $plan['input']['charge_amount'],
                    'min_days' => (int) $plan['input']['min_days'],
                    'max_days' => (int) $plan['input']['max_days'],
                    'is_active' => $plan['input']['kind'] === ShippingZone::FALLBACK ? true : (bool) ($plan['input']['is_active'] ?? true),
                    'position' => $plan['position'],
                ]);
                $zone->store_id = $store->id;
                $zone->save();
                $keep[$zone->id] = $plan['areas'];
            }

            $stale = $existing->keys()->diff(array_keys($keep))->all();
            ShippingZoneArea::query()->where('store_id', $store->id)->delete();
            if ($stale !== []) {
                ShippingZone::query()->where('store_id', $store->id)->whereIn('id', $stale)->delete();
            }
            $rows = [];
            foreach ($keep as $zoneId => $areas) {
                foreach ($areas as [$district, $thana]) {
                    $rows[] = ['tenant_id' => $store->tenant_id, 'store_id' => $store->id, 'zone_id' => $zoneId, 'district_code' => $district, 'thana_code' => $thana];
                }
            }
            foreach (array_chunk($rows, 200) as $chunk) {
                ShippingZoneArea::query()->insert($chunk);
            }

            if (array_key_exists('free_delivery_over_amount', $input)) {
                $settings = StoreSetting::query()->firstOrCreate(['store_id' => $store->id]);
                $settings->forceFill(['free_delivery_over_amount' => $input['free_delivery_over_amount']])->save();
            }

            $fallback = ShippingZone::query()->where('store_id', $store->id)->where('kind', ShippingZone::FALLBACK)->first();
            $this->audit->log('shipping.updated', $fallback, ['zones' => count($keep)]);
            app(StorefrontRevalidationObserver::class)->dispatch($store->tenant_id, $store->id);
        });
    }

    /**
     * P5-8 defaults (onboarding 06 / backfill / DemoSeeder): only for stores without any zone. Idempotent.
     */
    public function provisionDefaults(Store $store): bool
    {
        if (ShippingZone::query()->where('store_id', $store->id)->exists()) {
            if (! $this->configured($store->id)) {
                $fallback = new ShippingZone(self::DEFAULT_FALLBACK + ['kind' => ShippingZone::FALLBACK, 'position' => 99]);
                $fallback->store_id = $store->id;
                $fallback->save();

                return true;
            }

            return false;
        }
        $this->save($store, ['zones' => [
            self::DEFAULT_INSIDE + ['kind' => ShippingZone::CUSTOM, 'areas' => array_map(
                fn (string $code) => ['district_code' => 'dhaka', 'thana_code' => $code],
                $this->geo->cityThanas('dhaka'),
            )],
            self::DEFAULT_FALLBACK + ['kind' => ShippingZone::FALLBACK, 'areas' => []],
        ]]);

        return true;
    }

    // ---------------- Pickup locations ----------------

    /** @param array<string, mixed> $input validated PickupLocationInput */
    public function createPickup(Store $store, array $input): PickupLocation
    {
        return DB::transaction(function () use ($store, $input) {
            $count = PickupLocation::query()->where('store_id', $store->id)->lockForUpdate()->count();
            if ($count >= PickupLocation::MAX_PER_STORE) {
                throw new ApiException(409, 'conflict', 'You can add up to 10 pickup addresses.');
            }
            $location = new PickupLocation($this->pickupFields($input));
            $location->store_id = $store->id;
            $makeDefault = $count === 0 || ($input['is_default'] ?? false) === true;
            if ($makeDefault) {
                PickupLocation::query()->where('store_id', $store->id)->where('is_default', true)->update(['is_default' => false]);
            }
            $location->is_default = $makeDefault;
            $location->save();

            return $location;
        });
    }

    /** @param array<string, mixed> $input validated partial PickupLocationInput */
    public function updatePickup(Store $store, PickupLocation $location, array $input): PickupLocation
    {
        return DB::transaction(function () use ($store, $location, $input) {
            $location->fill($this->pickupFields($input));
            if (($input['is_default'] ?? null) === true && ! $location->is_default) {
                PickupLocation::query()->where('store_id', $store->id)->where('is_default', true)->update(['is_default' => false]);
                $location->is_default = true;
            }
            $location->save();

            return $location;
        });
    }

    public function deletePickup(Store $store, PickupLocation $location): void
    {
        DB::transaction(function () use ($store, $location) {
            if (ShippingZone::query()->where('store_id', $store->id)->where('pickup_location_id', $location->id)->exists()) {
                throw new ApiException(409, 'conflict', 'A delivery zone uses this pickup address.');
            }
            $wasDefault = $location->is_default;
            $location->delete();
            if ($wasDefault) {
                $next = PickupLocation::query()->where('store_id', $store->id)->orderBy('created_at')->orderBy('id')->first();
                if ($next !== null) {
                    $next->is_default = true;
                    $next->save();
                }
            }
        });
    }

    /** @return array<string, mixed> */
    private function pickupFields(array $input): array
    {
        $out = [];
        foreach (['name', 'contact_name', 'address_line'] as $key) {
            if (array_key_exists($key, $input)) {
                $out[$key] = is_string($input[$key]) ? (trim($input[$key]) ?: null) : null;
            }
        }
        if (array_key_exists('contact_phone', $input)) {
            $out['contact_phone'] = Phone::bdMsisdn($input['contact_phone']);
        }
        foreach (['district_code', 'thana_code'] as $key) {
            if (array_key_exists($key, $input)) {
                $out[$key] = $input[$key];
            }
        }

        return $out;
    }
}
