<?php

namespace App\Domain\Geo;

use Illuminate\Validation\ValidationException;

/**
 * §2.1 shipping address: validates AddressInput and returns the stored Address snapshot (codes + names from the geo
 * dataset; division derived from the district, never taken from input). Control characters are stripped.
 */
final class AddressValidator
{
    public function __construct(private readonly BdGeo $geo) {}

    /** Laravel rules for an AddressInput under $prefix (e.g. "shipping_address"). @return array<string, list<mixed>> */
    public static function rules(string $prefix, bool $required = true): array
    {
        return [
            $prefix => [$required ? 'required' : 'sometimes', 'array'],
            "{$prefix}.district_code" => ['required_with:'.$prefix, 'string', 'max:32'],
            "{$prefix}.thana_code" => ['required_with:'.$prefix, 'string', 'max:48'],
            "{$prefix}.area" => ['sometimes', 'nullable', 'string', 'max:120'],
            "{$prefix}.address_line" => ['required_with:'.$prefix, 'string', 'min:5', 'max:255'],
            "{$prefix}.landmark" => ['sometimes', 'nullable', 'string', 'max:160'],
            "{$prefix}.label" => ['sometimes', 'nullable', 'string', 'in:home,office'],
        ];
    }

    /**
     * @param  array<string, mixed>  $input  validated by rules()
     * @return array{division_code: string, division: string, district_code: string, district: string, thana_code: string, thana: string, area: string|null, address_line: string, landmark: string|null, label: string|null}
     *
     * @throws ValidationException unknown codes / thana outside the district
     */
    public function snapshot(array $input, string $prefix = 'shipping_address'): array
    {
        $district = $this->geo->district((string) ($input['district_code'] ?? ''));
        if ($district === null) {
            throw ValidationException::withMessages(["{$prefix}.district_code" => ['Choose a district.']]);
        }
        $thana = $this->geo->thana((string) ($input['thana_code'] ?? ''));
        if ($thana === null || $thana['district_code'] !== $district['code']) {
            throw ValidationException::withMessages(["{$prefix}.thana_code" => ['Choose a thana or upazila in '.$district['name'].'.']]);
        }
        $division = $this->geo->division($district['division_code']);
        $addressLine = self::clean($input['address_line'] ?? null);
        if ($addressLine === null || mb_strlen($addressLine) < 5) {
            throw ValidationException::withMessages(["{$prefix}.address_line" => ['Enter the house, road and flat.']]);
        }

        return [
            'division_code' => $district['division_code'],
            'division' => $division['name'] ?? '',
            'district_code' => $district['code'],
            'district' => $district['name'],
            'thana_code' => $thana['code'],
            'thana' => $thana['name'],
            'area' => self::clean($input['area'] ?? null),
            'address_line' => $addressLine,
            'landmark' => self::clean($input['landmark'] ?? null),
            'label' => in_array($input['label'] ?? null, ['home', 'office'], true) ? $input['label'] : null,
        ];
    }

    /** Strips control characters and collapses whitespace; '' → null. */
    public static function clean(mixed $value): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $value = trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value)));

        return $value === '' ? null : $value;
    }
}
