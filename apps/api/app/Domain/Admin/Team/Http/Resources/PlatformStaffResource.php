<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Resources;

use App\Domain\Admin\Team\Models\PlatformInvitation;
use App\Domain\Identity\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** openapi `PlatformStaff`: one row per staff user (`kind: user`) or open invitation (`kind: invitation`). */
class PlatformStaffResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        $row = $this->resource;
        if ($row instanceof PlatformInvitation) {
            return [
                'id' => $row->id,
                'kind' => 'invitation',
                'name' => null,
                'email' => $row->email,
                'role' => $row->role,
                'status' => 'invited',
                'totp_enrolled' => false,
                'invited_at' => $row->created_at?->toIso8601ZuluString(),
                'expires_at' => $row->expires_at->toIso8601ZuluString(),
            ];
        }

        /** @var User $row */
        return [
            'id' => $row->id,
            'kind' => 'user',
            'name' => $row->name,
            'email' => $row->email,
            'role' => $row->platform_role,
            'status' => self::status($row),
            'totp_enrolled' => $row->totp_confirmed_at !== null,
            'invited_at' => null,
            'expires_at' => null,
        ];
    }

    public static function status(User $user): string
    {
        return match (true) {
            $user->platform_disabled_at !== null => 'disabled',
            $user->platform_locked_until !== null && $user->platform_locked_until->isFuture() => 'locked',
            default => 'active',
        };
    }
}
