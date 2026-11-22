<?php

namespace App\Domain\Shipping\Http;

use App\Domain\Geo\BdGeo;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Shipping\ShippingPresenter;
use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/** §3.5 shipping settings and pickup locations. Reads O A S; writes O A (ManageSettings via StorePolicy::update). */
class ShippingController
{
    public function __construct(
        private readonly ShippingService $shipping,
        private readonly BdGeo $geo,
    ) {}

    public function show(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => $this->shipping->settings($store)]);
    }

    public function update(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('update', $store);
        $input = $request->validate([
            'zones' => ['present', 'array', 'max:'.ShippingZone::MAX_ZONES],
            'zones.*' => ['array:id,name,kind,charge_amount,min_days,max_days,is_active,areas'],
            'zones.*.id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'zones.*.name' => ['required', 'string', 'min:1', 'max:60'],
            'zones.*.kind' => ['required', 'string', 'in:custom,fallback'],
            'zones.*.charge_amount' => ['required', 'integer:strict', 'min:0', 'max:1000000'],
            'zones.*.min_days' => ['required', 'integer:strict', 'min:0', 'max:30'],
            'zones.*.max_days' => ['required', 'integer:strict', 'min:0', 'max:30'],
            'zones.*.is_active' => ['sometimes', 'boolean'],
            'zones.*.areas' => ['sometimes', 'array', 'max:'.ShippingZone::MAX_AREAS],
            'zones.*.areas.*' => ['array:district_code,thana_code'],
            'zones.*.areas.*.district_code' => ['required', 'string', 'max:32'],
            'zones.*.areas.*.thana_code' => ['sometimes', 'nullable', 'string', 'max:48'],
            'free_delivery_over_amount' => ['present', 'nullable', 'integer:strict', 'min:100', 'max:1000000000'],
        ]);
        $this->shipping->save($store, $input);

        return new JsonResponse(['data' => $this->shipping->settings($store)]);
    }

    public function storePickup(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('update', $store);
        $input = $this->pickupInput($request, true);

        return new JsonResponse(['data' => ShippingPresenter::pickup($this->shipping->createPickup($store, $input))], 201);
    }

    public function updatePickup(Request $request, Store $store, PickupLocation $location): JsonResponse
    {
        Gate::authorize('update', $store);
        $input = $this->pickupInput($request, false, $location);

        return new JsonResponse(['data' => ShippingPresenter::pickup($this->shipping->updatePickup($store, $location, $input))]);
    }

    public function destroyPickup(Store $store, PickupLocation $location): Response
    {
        Gate::authorize('update', $store);
        $this->shipping->deletePickup($store, $location);

        return response()->noContent();
    }

    /** @return array<string, mixed> */
    private function pickupInput(Request $request, bool $create, ?PickupLocation $current = null): array
    {
        $req = $create ? 'required' : 'sometimes';
        $input = $request->validate([
            'name' => [$req, 'string', 'min:1', 'max:60'],
            'contact_name' => ['sometimes', 'nullable', 'string', 'max:80'],
            'contact_phone' => ['sometimes', 'nullable', 'string', PhoneRule::bdMobile()],
            'district_code' => [$req, 'string', 'max:32'],
            'thana_code' => [$req, 'string', 'max:48'],
            'address_line' => [$req, 'string', 'min:5', 'max:255'],
            'is_default' => ['sometimes', 'boolean'],
        ]);
        $district = $input['district_code'] ?? $current?->district_code;
        $thana = $input['thana_code'] ?? $current?->thana_code;
        if ($this->geo->district($district) === null) {
            throw ValidationException::withMessages(['district_code' => ['Choose a district.']]);
        }
        if (! $this->geo->thanaInDistrict((string) $district, (string) $thana)) {
            throw ValidationException::withMessages(['thana_code' => ['Choose a thana or upazila in this district.']]);
        }

        return $input;
    }
}
