<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\CourierArea;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\CourierAreaMapping;
use App\Domain\Geo\BdGeo;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Support\Carbon;

/**
 * Courier area mapping (P5B-39). Area lists are proxied from the courier and cached 24 h per account in TenantCache;
 * remembered choices live in courier_area_mappings (per store × provider × district/thana, thana '' = whole
 * district). suggest() returns the remembered ids, else a name match of our district/thana against the courier's
 * cities/zones (Pathao) or areas (RedX). Steadfast needs no mapping (free-text address).
 */
final class AreaMapper
{
    /** Our district names (bd.json, new spellings) → older spellings couriers still use. */
    private const ALIASES = [
        'chattogram' => ['chittagong', 'ctg'], 'cumilla' => ['comilla'], 'barishal' => ['barisal'],
        'jashore' => ['jessore'], 'bogura' => ['bogra'], 'chapainawabganj' => ['chapai nawabganj', 'nawabganj'],
        'jhalokati' => ['jhalakathi', 'jhalokathi'], 'moulvibazar' => ['maulvibazar'], 'netrokona' => ['netrakona'],
        'coxsbazar' => ["cox's bazar", 'coxs bazar'], 'brahmanbaria' => ['b. baria', 'b baria'],
    ];

    public function __construct(
        private readonly CourierManager $couriers,
        private readonly TenantCache $cache,
        private readonly BdGeo $geo,
    ) {}

    /** @return list<CourierArea> (cached 24 h per account, level and parent) */
    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        $key = "couriers:areas:{$account->id}:{$account->revision}:{$level}:".($parentId ?? '-');
        $rows = $this->cache->get($key);
        if (! is_array($rows)) {
            $rows = array_map(fn (CourierArea $a) => $a->toArray(), $this->couriers->driver($account->provider)->areas($account, $level, $parentId));
            $this->cache->put($key, $rows, (int) config('couriers.areas_cache_seconds', 86400));
        }

        return array_map(fn (array $a) => CourierArea::fromArray($a), $rows);
    }

    /** The remembered mapping for a district/thana (exact thana first, then the district-wide row). */
    public function mapping(CourierAccount $account, string $districtCode, ?string $thanaCode): ?CourierAreaMapping
    {
        return CourierAreaMapping::query()
            ->where('store_id', $account->store_id)->where('provider', $account->provider)->where('district_code', $districtCode)
            ->whereIn('thana_code', array_values(array_unique([(string) $thanaCode, ''])))
            ->orderByDesc('thana_code')
            ->first();
    }

    /** @param array{city_id: ?string, zone_id: ?string, area_id: ?string} $area */
    public function remember(CourierAccount $account, string $districtCode, ?string $thanaCode, array $area, string $label): void
    {
        $now = Carbon::now();
        CourierAreaMapping::query()->upsert([[
            'tenant_id' => $account->tenant_id, 'store_id' => $account->store_id, 'provider' => $account->provider,
            'district_code' => $districtCode, 'thana_code' => (string) $thanaCode,
            'provider_city_id' => $area['city_id'], 'provider_zone_id' => $area['zone_id'], 'provider_area_id' => $area['area_id'],
            'label' => mb_substr($label, 0, 160), 'created_at' => $now, 'updated_at' => $now,
        ]], ['store_id', 'provider', 'district_code', 'thana_code'], ['provider_city_id', 'provider_zone_id', 'provider_area_id', 'label', 'updated_at']);
    }

    /**
     * Pre-selection for the booking dialog: the remembered mapping, else a name match. Null when nothing matches.
     *
     * @return array{city_id: ?string, zone_id: ?string, area_id: ?string}|null
     */
    public function suggest(CourierAccount $account, string $districtCode, ?string $thanaCode): ?array
    {
        if ($account->provider === CourierAccount::STEADFAST) {
            return null;
        }
        $saved = $this->mapping($account, $districtCode, $thanaCode);
        if ($saved !== null) {
            return $saved->toArea();
        }
        $district = $this->geo->district($districtCode);
        $thana = $thanaCode !== null && $thanaCode !== '' ? $this->geo->thana($thanaCode) : null;
        if ($district === null) {
            return null;
        }

        if ($account->provider === CourierAccount::REDX) {
            $areas = $this->areas($account, 'area', null);
            $hit = ($thana !== null ? self::match($areas, [(string) $thana['name']]) : null) ?? self::match($areas, self::names((string) $district['name']));

            return $hit === null ? null : ['city_id' => null, 'zone_id' => null, 'area_id' => $hit->id];
        }

        $city = self::match($this->areas($account, 'city', null), self::names((string) $district['name']));
        if ($city === null) {
            return null;
        }
        $zone = $thana !== null ? self::match($this->areas($account, 'zone', $city->id), [(string) $thana['name']]) : null;

        return ['city_id' => $city->id, 'zone_id' => $zone?->id, 'area_id' => null];
    }

    /** @return list<string> the name and its known aliases */
    private static function names(string $name): array
    {
        return [$name, ...(self::ALIASES[self::norm($name)] ?? [])];
    }

    /**
     * Exact normalised name first, then a courier name that starts with ours ("Mirpur" → "Mirpur 10" is NOT taken:
     * only "Dhaka" → "Dhaka City" style prefixes of whole words).
     *
     * @param  list<CourierArea>  $areas
     * @param  list<string>  $names
     */
    private static function match(array $areas, array $names): ?CourierArea
    {
        $wanted = array_map(self::norm(...), $names);
        foreach ($areas as $area) {
            if (in_array(self::norm($area->name), $wanted, true)) {
                return $area;
            }
        }
        foreach ($areas as $area) {
            $words = strtolower(trim($area->name));
            foreach ($names as $name) {
                $n = strtolower(trim($name));
                if ($n !== '' && preg_match('/^'.preg_quote($n, '/').'\s+(city|sadar|metro|metropolitan)$/', $words) === 1) {
                    return $area;
                }
            }
        }

        return null;
    }

    private static function norm(string $name): string
    {
        return (string) preg_replace('/[^a-z0-9]+/', '', strtolower($name));
    }
}
