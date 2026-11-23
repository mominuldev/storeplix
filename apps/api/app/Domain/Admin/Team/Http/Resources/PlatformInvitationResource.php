<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Resources;

use App\Domain\Admin\Team\Models\PlatformInvitation;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * openapi `PlatformInvitation`.
 *
 * @mixin PlatformInvitation
 */
class PlatformInvitationResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var PlatformInvitation $invitation */
        $invitation = $this->resource;

        return [
            'id' => $invitation->id,
            'email' => $invitation->email,
            'role' => $invitation->role,
            'expires_at' => $invitation->expires_at->toIso8601ZuluString(),
            'created_at' => $invitation->created_at?->toIso8601ZuluString(),
        ];
    }
}
