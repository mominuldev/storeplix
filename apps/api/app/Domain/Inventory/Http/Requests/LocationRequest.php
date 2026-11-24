<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Http\Requests;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Location;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * POST / PATCH /stores/{store}/locations (PHASE-8-8C §4, LocationInput). PATCH = every field optional. `perm:
 * settings.manage` already ran. A POST that would add a 2nd+ active location without `multi_warehouse` → 402
 * `feature_not_in_plan` BEFORE body validation (P88C-13); LocationService re-checks under the row locks.
 */
class LocationRequest extends FormRequest
{
    public function authorize(): bool
    {
        $store = $this->route('store');
        if ($this->isMethod('POST') && $store instanceof Store && Locations::activeCount($store->id) >= 1) {
            $tenant = app(TenantContext::class)->tenant();
            if ($tenant !== null) {
                FeatureGate::assertAllows($tenant, Feature::MultiWarehouse);
            }
        }

        return true;
    }

    public function rules(): array
    {
        $patch = $this->isMethod('PATCH');

        return [
            'name' => [$patch ? 'sometimes' : 'required', 'string', 'min:1', 'max:60', 'regex:/^[^\x00-\x1F\x7F]*$/u', 'regex:/\S/u'],
            'type' => [$patch ? 'sometimes' : 'required', 'string', Rule::in(Location::TYPES)],
            'address' => ['sometimes', 'nullable', 'string', 'max:200', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'pickup_location_id' => ['sometimes', 'nullable', 'string', 'size:26'],
        ];
    }
}
