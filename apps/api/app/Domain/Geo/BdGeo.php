<?php

namespace App\Domain\Geo;

use RuntimeException;

/**
 * Bangladesh geography (P5-10): static, versioned dataset in resources/geo/bd.json (source and licence in the README
 * next to it). Loaded once per process; lookups by stable lowercase codes.
 */
final class BdGeo
{
    /** @var array{version: string, divisions: list<array<string, string>>, districts: list<array<string, string>>, thanas: list<array<string, mixed>>}|null */
    private ?array $data = null;

    /** @var array<string, array<string, string>> */
    private array $divisions = [];

    /** @var array<string, array<string, string>> */
    private array $districts = [];

    /** @var array<string, array<string, mixed>> */
    private array $thanas = [];

    /** @return array{version: string, divisions: list<array<string, string>>, districts: list<array<string, string>>, thanas: list<array<string, mixed>>} */
    public function all(): array
    {
        if ($this->data === null) {
            $path = resource_path('geo/bd.json');
            $data = json_decode((string) file_get_contents($path), true);
            if (! is_array($data) || ! isset($data['version'], $data['divisions'], $data['districts'], $data['thanas'])) {
                throw new RuntimeException('resources/geo/bd.json is missing or invalid.');
            }
            $this->data = $data;
            $this->divisions = array_column($data['divisions'], null, 'code');
            $this->districts = array_column($data['districts'], null, 'code');
            $this->thanas = array_column($data['thanas'], null, 'code');
        }

        return $this->data;
    }

    public function version(): string
    {
        return $this->all()['version'];
    }

    /** @return array{code: string, name: string, name_bn: string}|null */
    public function division(?string $code): ?array
    {
        $this->all();

        return $code === null ? null : ($this->divisions[$code] ?? null);
    }

    /** @return array{code: string, division_code: string, name: string, name_bn: string}|null */
    public function district(?string $code): ?array
    {
        $this->all();

        return $code === null ? null : ($this->districts[$code] ?? null);
    }

    /** @return array{code: string, district_code: string, name: string, name_bn: string, is_city: bool}|null */
    public function thana(?string $code): ?array
    {
        $this->all();

        return $code === null ? null : ($this->thanas[$code] ?? null);
    }

    /** True when the thana exists and lies in the district. */
    public function thanaInDistrict(string $districtCode, string $thanaCode): bool
    {
        return ($this->thana($thanaCode)['district_code'] ?? null) === $districtCode;
    }

    /** @return list<string> codes of the city (metropolitan) thanas of a district */
    public function cityThanas(string $districtCode): array
    {
        return array_values(array_map(
            fn (array $t) => $t['code'],
            array_filter($this->all()['thanas'], fn (array $t) => $t['district_code'] === $districtCode && $t['is_city']),
        ));
    }
}
