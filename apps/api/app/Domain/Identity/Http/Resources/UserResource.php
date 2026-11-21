<?php

namespace App\Domain\Identity\Http\Resources;

use App\Domain\Identity\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * User in @storeplix/types (+ `tenants: TenantMembership[]` when loaded).
 *
 * @mixin User
 */
class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'phone' => $this->phone,
            'phone_verified_at' => $this->phone_verified_at?->toIso8601ZuluString(),
            'password_changed_at' => $this->password_changed_at?->toIso8601ZuluString(),
            'created_at' => $this->created_at?->toIso8601ZuluString(),
            'tenants' => $this->whenLoaded('tenants', fn () => $this->tenants
                ->sortBy('pivot.created_at')
                ->values()
                ->map(fn ($tenant) => [
                    'id' => $tenant->id,
                    'name' => $tenant->name,
                    'role' => $tenant->pivot->role,
                ])->all()),
        ];
    }
}
