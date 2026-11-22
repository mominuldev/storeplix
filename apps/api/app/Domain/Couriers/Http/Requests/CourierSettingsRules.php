<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Requests;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * Partial CourierSettings (P5B-32) for connect and PATCH. Unknown keys are rejected (only this provider's keys are
 * allowed); `pickup_location_id` must be a pickup location of THIS store → 422 on `settings.pickup_location_id`
 * (foreign-id rule, never 403/404). Bounds agreed with WEB-1: weight 100–20000 g (Pathao 500–10000); the description
 * template ≤ 120 chars with only the {items} and {order_no} placeholders.
 */
final class CourierSettingsRules
{
    /** @return array<string, mixed> */
    public static function rules(string $provider): array
    {
        $keys = ['pickup_location_id', 'parcel_description', 'default_weight_grams'];
        $rules = [
            'settings.pickup_location_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'settings.parcel_description' => ['sometimes', 'string', 'min:1', 'max:120', 'regex:/^(?:[^{}]|\{items\}|\{order_no\})*$/u'],
            'settings.default_weight_grams' => ['sometimes', 'integer:strict', $provider === CourierAccount::PATHAO ? 'between:500,10000' : 'between:100,20000'],
        ];
        if ($provider === CourierAccount::PATHAO) {
            $keys = [...$keys, 'pathao_store_id', 'delivery_type'];
            $rules['settings.pathao_store_id'] = ['sometimes', 'nullable', 'string', 'max:32', 'regex:/^[A-Za-z0-9_-]+$/'];
            $rules['settings.delivery_type'] = ['sometimes', 'integer:strict', Rule::in([48, 12])];
        }
        if ($provider === CourierAccount::REDX) {
            $keys = [...$keys, 'redx_pickup_store_id'];
            $rules['settings.redx_pickup_store_id'] = ['sometimes', 'nullable', 'string', 'max:32', 'regex:/^[A-Za-z0-9_-]+$/'];
        }

        return ['settings' => ['sometimes', 'array:'.implode(',', $keys)]] + $rules;
    }

    /** @return array<string, string> */
    public static function messages(): array
    {
        return ['settings.parcel_description.regex' => 'Only the {items} and {order_no} placeholders are allowed.'];
    }

    public static function checkPickupLocation(Validator $validator, Request $request): void
    {
        $id = $request->input('settings.pickup_location_id');
        if (! is_string($id) || $validator->errors()->has('settings.pickup_location_id')) {
            return;
        }
        $store = $request->route('store');
        $storeId = $store instanceof Store ? $store->id : (string) $store;
        if (! PickupLocation::query()->where('store_id', $storeId)->whereKey(strtolower($id))->exists()) {
            $validator->errors()->add('settings.pickup_location_id', 'Unknown pickup location.');
        }
    }

    /**
     * Validated settings → [column pickup_location_id (or the sentinel "unchanged"), jsonb settings to merge].
     *
     * @param  array<string, mixed>  $settings
     * @return array{0: string|null|false, 1: array<string, mixed>}
     */
    public static function split(array $settings): array
    {
        $pickup = array_key_exists('pickup_location_id', $settings)
            ? ($settings['pickup_location_id'] === null ? null : strtolower((string) $settings['pickup_location_id']))
            : false;
        unset($settings['pickup_location_id']);

        return [$pickup, $settings];
    }
}
