<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Http\Resources;

use App\Domain\Admin\Auth\RecoveryCodes;
use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * openapi `PlatformUser` (PHASE-8-1 §8).
 *
 * @mixin User
 */
class PlatformUserResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var User $user */
        $user = $this->resource;
        $role = PlatformRole::tryFrom((string) $user->platform_role);

        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'platform_role' => $role?->value,
            'permissions' => array_map(fn (PlatformPermission $p) => $p->value, $role?->permissions() ?? []),
            'totp_enrolled' => $user->totp_confirmed_at !== null,
            'recovery_codes_left' => app(RecoveryCodes::class)->remaining($user),
        ];
    }
}
