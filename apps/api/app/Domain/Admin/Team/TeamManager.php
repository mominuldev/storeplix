<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team;

use App\Domain\Admin\Auth\AdminSessions;
use App\Domain\Admin\Auth\RecoveryCodes;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Admin\Team\Mail\PlatformInvitationMail;
use App\Domain\Admin\Team\Models\PlatformInvitation;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Validation\ValidationException;

/**
 * Platform staff management (PHASE-8-1 P8-16, S79). Every event is platform-only (`tenant_id` null) with the platform
 * actor. Self rules (409 `staff_self_action`) and the last-active-super-admin rule (409 `last_super_admin`) live here,
 * so the API and the break-glass commands share them (the commands pass `$actor = null` and skip the self rule).
 */
final class TeamManager
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly AdminSessions $sessions,
        private readonly RecoveryCodes $recoveryCodes,
    ) {}

    /** @return array{0: PlatformInvitation, 1: string} the invitation and its plain token (only ever in the email) */
    public function invite(User $inviter, string $email, PlatformRole $role): array
    {
        $existing = User::query()->where('email', $email)->first();
        if ($existing !== null && $existing->platform_role !== null) {
            throw ValidationException::withMessages(['email' => ['This person is already on the team.']]);
        }

        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $invitation = DB::transaction(function () use ($inviter, $email, $role, $token) {
            // An expired open invitation would block the partial unique index: close it first.
            PlatformInvitation::query()->open()->where('email', $email)->where('expires_at', '<=', now())->update(['revoked_at' => now()]);
            if (PlatformInvitation::query()->usable()->where('email', $email)->exists()) {
                throw ValidationException::withMessages(['email' => ['This person already has an open invitation.']]);
            }

            return PlatformInvitation::query()->create([
                'email' => $email,
                'role' => $role->value,
                'token_hash' => PlatformInvitation::hashToken($token),
                'invited_by' => $inviter->id,
                'expires_at' => now()->addDays(PlatformInvitation::TTL_DAYS),
            ]);
        });

        Mail::to($email)->queue(new PlatformInvitationMail($token, $inviter->name, $role->value));
        $this->audit->log('admin.staff_invited', $invitation, ['role' => $role->value], actor: $inviter, tenantId: false, platform: true);

        return [$invitation, $token];
    }

    public function revokeInvitation(User $actor, PlatformInvitation $invitation): void
    {
        $invitation->forceFill(['revoked_at' => now()])->save();
        $this->audit->log('admin.staff_invitation_revoked', $invitation, ['role' => $invitation->role], actor: $actor, tenantId: false, platform: true);
    }

    public function changeRole(?User $actor, User $staff, PlatformRole $role, string $reason): User
    {
        $this->guardSelf($actor, $staff);
        $from = (string) $staff->platform_role;

        DB::transaction(function () use ($staff, $role, $from): void {
            if ($from === PlatformRole::SuperAdmin->value && $role !== PlatformRole::SuperAdmin) {
                $this->guardLastSuperAdmin($staff);
            }
            $staff->forceFill(['platform_role' => $role->value])->save();
        });

        if ($from !== $role->value) {
            $this->log('admin.staff_role_changed', $actor, $staff, ['from' => $from, 'to' => $role->value, 'reason' => $reason]);
        }

        return $staff;
    }

    public function disable(?User $actor, User $staff, string $reason): User
    {
        $this->guardSelf($actor, $staff);
        if ($staff->platform_disabled_at !== null) {
            return $staff;
        }

        DB::transaction(function () use ($staff): void {
            if ($staff->platform_role === PlatformRole::SuperAdmin->value) {
                $this->guardLastSuperAdmin($staff);
            }
            $staff->forceFill(['platform_disabled_at' => now()])->save();
        });

        $killed = $this->sessions->killAdminSessions($staff);
        $ended = app(ImpersonationService::class)->endAllForStaff($staff, 'revoked');
        $this->log('admin.staff_disabled', $actor, $staff, ['reason' => $reason, 'sessions_ended' => $killed, 'impersonations_ended' => $ended]);

        return $staff;
    }

    public function enable(?User $actor, User $staff, string $reason): User
    {
        if ($staff->platform_disabled_at === null) {
            return $staff;
        }
        $staff->forceFill(['platform_disabled_at' => null, 'platform_locked_until' => null])->save();
        $this->log('admin.staff_enabled', $actor, $staff, ['reason' => $reason]);

        return $staff;
    }

    /** Clears the TOTP secret and recovery codes (enrolment on next sign-in) and ends the user's admin sessions. */
    public function resetTotp(?User $actor, User $staff, string $reason): User
    {
        $this->guardSelf($actor, $staff);
        DB::transaction(function () use ($staff): void {
            $staff->forceFill(['totp_secret' => null, 'totp_confirmed_at' => null, 'totp_last_step' => null])->save();
            $this->recoveryCodes->clear($staff);
        });
        $killed = $this->sessions->killAdminSessions($staff);
        $this->log('admin.staff_2fa_reset', $actor, $staff, ['reason' => $reason, 'sessions_ended' => $killed]);

        return $staff;
    }

    /** `platform:grant` (break glass): no self or last-SA rule; re-enables a disabled user. */
    public function grant(User $user, PlatformRole $role, string $reason): User
    {
        $from = $user->platform_role;
        $user->forceFill(['platform_role' => $role->value, 'platform_disabled_at' => null, 'platform_locked_until' => null])->save();
        $this->log('admin.staff_granted', null, $user, ['from' => $from, 'to' => $role->value, 'reason' => $reason]);

        return $user;
    }

    /** `platform:revoke` (break glass): the user stops being staff; TOTP and recovery codes are cleared. */
    public function revoke(User $user, string $reason): User
    {
        $from = $user->platform_role;
        DB::transaction(function () use ($user): void {
            $user->forceFill(['platform_role' => null, 'totp_secret' => null, 'totp_confirmed_at' => null, 'totp_last_step' => null])->save();
            $this->recoveryCodes->clear($user);
        });
        $this->sessions->killAdminSessions($user);
        app(ImpersonationService::class)->endAllForStaff($user, 'revoked');
        $this->log('admin.staff_revoked', null, $user, ['from' => $from, 'reason' => $reason]);

        return $user;
    }

    /** @param array<string, mixed> $meta */
    private function log(string $action, ?User $actor, User $staff, array $meta): void
    {
        $actor === null
            ? $this->audit->log($action, $staff, $meta, tenantId: false, system: true)
            : $this->audit->log($action, $staff, $meta, actor: $actor, tenantId: false, platform: true);
    }

    private function guardSelf(?User $actor, User $staff): void
    {
        if ($actor !== null && $actor->id === $staff->id) {
            throw new ApiException(409, 'staff_self_action', 'You can’t do this to your own account. Ask another super admin.');
        }
    }

    /** Inside a transaction: `$staff` is an active super admin who is about to stop being one. */
    private function guardLastSuperAdmin(User $staff): void
    {
        $others = User::query()
            ->where('platform_role', PlatformRole::SuperAdmin->value)
            ->whereNull('platform_disabled_at')
            ->where('id', '!=', $staff->id)
            ->lockForUpdate() // Postgres refuses FOR UPDATE with an aggregate: lock the rows, count in PHP
            ->pluck('id')
            ->count();
        if ($staff->platform_disabled_at === null && $others === 0) {
            throw new ApiException(409, 'last_super_admin', 'At least one active super admin must remain.');
        }
    }
}
