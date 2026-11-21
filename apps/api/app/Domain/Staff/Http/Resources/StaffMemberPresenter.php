<?php

namespace App\Domain\Staff\Http\Resources;

use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Models\TenantUser;

/** Shapes StaffMember (@storeplix/types) for members and invitations alike. */
final class StaffMemberPresenter
{
    /** @return array<string, mixed> */
    public static function member(TenantUser $member, ?string $currentUserId): array
    {
        $user = $member->user;

        return [
            'id' => $member->id,
            'kind' => 'member',
            'user_id' => $member->user_id,
            'name' => $user?->name,
            'email' => (string) $user?->email,
            'phone' => $user?->phone,
            'role' => $member->role,
            'status' => 'active',
            'is_you' => $member->user_id === $currentUserId,
            'invited_by' => $member->inviter ? ['id' => $member->inviter->id, 'name' => $member->inviter->name] : null,
            'joined_at' => ($member->joined_at ?? $member->created_at)?->toIso8601ZuluString(),
            'expires_at' => null,
            'created_at' => $member->created_at?->toIso8601ZuluString(),
        ];
    }

    /** @return array<string, mixed> */
    public static function invitation(StaffInvitation $invitation): array
    {
        return [
            'id' => $invitation->id,
            'kind' => 'invitation',
            'user_id' => null,
            'name' => $invitation->name,
            'email' => $invitation->email,
            'phone' => null,
            'role' => $invitation->role,
            'status' => $invitation->isExpired() ? 'expired' : 'invited',
            'is_you' => false,
            'invited_by' => $invitation->inviter ? ['id' => $invitation->inviter->id, 'name' => $invitation->inviter->name] : null,
            'joined_at' => null,
            'expires_at' => $invitation->expires_at->toIso8601ZuluString(),
            'created_at' => $invitation->created_at?->toIso8601ZuluString(),
        ];
    }
}
