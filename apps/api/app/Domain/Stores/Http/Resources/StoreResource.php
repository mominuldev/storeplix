<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Stores\Models\Store;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Store in @storeplix/types.
 *
 * @mixin Store
 */
class StoreResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'tenant_id' => $this->tenant_id,
            'name' => $this->name,
            'slug' => $this->slug,
            'status' => $this->status,
            'country' => $this->country,
            'currency' => $this->currency,
            'business_categories' => array_values($this->business_categories ?? []),
            'name_bn' => $this->name_bn,
            'timezone' => $this->timezone,
            'primary_domain' => $this->primaryDomain?->hostname,
            'created_at' => $this->created_at?->toIso8601ZuluString(),
        ];
    }
}
