<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation;

use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\Memberships;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * PHASE-8-1 P8-9 – P8-11, §4.4 (ADR 0015): ticket issue, consume, end, revoke, staff disable and expiry of read-only
 * impersonations. `platform_impersonations` is a platform table read and written on the app connection; the tenant
 * audit rows (`admin.impersonation_started` / `admin.impersonation_ended`) are written inside the target tenant so the
 * RLS `WITH CHECK` on `audit_logs` holds. State changes are conditional single UPDATEs (`… WHERE status = ?`), so a
 * ticket is consumed at most once and every session ends (and is audited) at most once.
 *
 * The plain ticket exists only in the `create()` return value (the admin response); it is never stored or logged.
 */
final class ImpersonationService
{
    public const STARTED = 'admin.impersonation_started';

    public const ENDED = 'admin.impersonation_ended';

    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** Active staff (not disabled, not locked) whose role grants `impersonate` (PHASE-8-1 §2.1). */
    public static function staffMayImpersonate(?User $staff): bool
    {
        $role = PlatformRole::tryFrom((string) $staff?->platform_role);

        return $staff !== null && $role !== null && $role->can(PlatformPermission::Impersonate)
            && $staff->platform_disabled_at === null
            && ($staff->platform_locked_until === null || ! $staff->platform_locked_until->isFuture());
    }

    public static function hashTicket(string $ticket): string
    {
        return hash('sha256', $ticket);
    }

    /**
     * Issues a single-use ticket (32 random bytes, base64url) valid `admin.impersonation_ticket_seconds`.
     *
     * @return array{0: PlatformImpersonation, 1: string} the pending row and the merchant-app URL carrying the ticket in its fragment
     */
    public function create(User $staff, Tenant $tenant, string $reason, ?string $ticketRef, ?string $ip, ?string $userAgent): array
    {
        $ticket = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');

        $row = PlatformImpersonation::query()->create([
            'staff_user_id' => $staff->id,
            'target_tenant_id' => $tenant->id,
            'reason' => $reason,
            'ticket_ref' => $ticketRef !== null && $ticketRef !== '' ? $ticketRef : null,
            'ticket_hash' => self::hashTicket($ticket),
            'status' => PlatformImpersonation::PENDING,
            'ticket_expires_at' => now()->addSeconds((int) config('admin.impersonation_ticket_seconds', 60)),
            'ip' => $ip,
            'user_agent' => $userAgent !== null ? (Str::limit($userAgent, 252, '...') ?: null) : null,
        ]);

        $url = rtrim((string) config('storeplix.merchant_app_url'), '/').'/impersonate#ticket='.$ticket;

        return [$row, $url];
    }

    /**
     * Exchanges a ticket for an active session row. Unknown, used, expired tickets, a row that is not pending, or a
     * staff user who lost `impersonate` all return null (the caller answers the same 404 for every case).
     */
    public function consume(string $ticket): ?PlatformImpersonation
    {
        if ($ticket === '' || strlen($ticket) > 128) {
            return null;
        }

        $row = PlatformImpersonation::query()->where('ticket_hash', self::hashTicket($ticket))->first();
        if ($row === null || $row->status !== PlatformImpersonation::PENDING) {
            return null;
        }
        if (! $row->ticket_expires_at->isFuture()) {
            $this->markExpired($row);

            return null;
        }

        $staff = User::query()->find($row->staff_user_id);
        $tenant = Tenant::query()->find($row->target_tenant_id);
        if ($tenant === null || ! self::staffMayImpersonate($staff)) {
            return null;
        }

        // Whole seconds, so the session marker (EnforceAbsoluteSessionExpiry, int timestamp) and the row agree.
        $now = now()->startOfSecond();
        $claimed = PlatformImpersonation::query()->whereKey($row->id)->where('status', PlatformImpersonation::PENDING)
            ->update([
                'status' => PlatformImpersonation::ACTIVE,
                'started_at' => $now,
                'expires_at' => $now->copy()->addMinutes(self::minutes()),
                'updated_at' => $now,
            ]);
        if ($claimed !== 1) {
            return null;
        }
        $row->refresh();

        $this->context->run($tenant, fn () => $this->audit->log(self::STARTED, $row, [
            'impersonation_id' => $row->id,
            'reason' => $row->reason,
            'ticket_ref' => $row->ticket_ref,
            'expires_at' => $row->expires_at?->toIso8601ZuluString(),
        ], actor: $staff, tenantId: $tenant->id, platform: true));

        return $row;
    }

    /**
     * Ends an active session (`ended_by`: staff | expiry | revoked) and writes `admin.impersonation_ended` on the
     * tenant. Actor: `$actor`, else the request user (e.g. the super admin disabling a staff member), else system.
     *
     * @param  array<string, mixed>  $meta
     * @return bool false when the row was not active (nothing written)
     */
    public function end(PlatformImpersonation $row, string $endedBy, ?User $actor = null, bool $system = false, array $meta = []): bool
    {
        $now = now();
        $ended = PlatformImpersonation::query()->whereKey($row->id)->where('status', PlatformImpersonation::ACTIVE)
            ->update(['status' => PlatformImpersonation::ENDED, 'ended_at' => $now, 'ended_by' => $endedBy, 'updated_at' => $now]);
        if ($ended !== 1) {
            return false;
        }
        $row->refresh();
        $this->auditEnded($row, $endedBy, $actor, $system, $meta);

        return true;
    }

    /**
     * POST /admin/impersonations/{id}/revoke (SA): an active session ends at its next request (401
     * `impersonation_ended`); a pending ticket can no longer be consumed. Already ended / expired → 409.
     */
    public function revoke(PlatformImpersonation $row, User $by, string $reason): PlatformImpersonation
    {
        if ($row->status === PlatformImpersonation::ACTIVE
            && $this->end($row, PlatformImpersonation::ENDED_BY_REVOKED, $by, meta: ['reason' => $reason])) {
            return $row;
        }

        if ($row->status === PlatformImpersonation::PENDING) {
            $now = now();
            $done = PlatformImpersonation::query()->whereKey($row->id)->where('status', PlatformImpersonation::PENDING)
                ->update(['status' => PlatformImpersonation::ENDED, 'ended_at' => $now, 'ended_by' => PlatformImpersonation::ENDED_BY_REVOKED, 'updated_at' => $now]);
            if ($done === 1) {
                $row->refresh();
                $this->auditEnded($row, PlatformImpersonation::ENDED_BY_REVOKED, $by, false, ['reason' => $reason]);

                return $row;
            }
        }

        throw new ApiException(409, 'invalid_state_transition', 'This impersonation has already ended.');
    }

    /**
     * Called by the team module when a staff member is disabled (S74): every active session of theirs ends now,
     * every pending ticket expires. Returns the number of sessions ended.
     */
    public function endAllForStaff(User $staff, string $endedBy = PlatformImpersonation::ENDED_BY_REVOKED): int
    {
        $count = 0;
        PlatformImpersonation::query()->where('staff_user_id', $staff->id)->where('status', PlatformImpersonation::ACTIVE)
            ->get()->each(function (PlatformImpersonation $row) use ($endedBy, &$count): void {
                $count += $this->end($row, $endedBy) ? 1 : 0;
            });

        PlatformImpersonation::query()->where('staff_user_id', $staff->id)->where('status', PlatformImpersonation::PENDING)
            ->update(['status' => PlatformImpersonation::EXPIRED, 'updated_at' => now()]);

        return $count;
    }

    /**
     * `admin:close-impersonations` (§4.4): active rows past `expires_at` → ended (expiry) + audit; pending rows past
     * `ticket_expires_at` → expired (silent: no tenant audit row).
     *
     * @return array{ended: int, expired: int}
     */
    public function expire(): array
    {
        $ended = 0;
        PlatformImpersonation::query()->where('status', PlatformImpersonation::ACTIVE)->where('expires_at', '<=', now())
            ->orderBy('expires_at')->get()->each(function (PlatformImpersonation $row) use (&$ended): void {
                $ended += $this->end($row, PlatformImpersonation::ENDED_BY_EXPIRY, system: true) ? 1 : 0;
            });

        $expired = PlatformImpersonation::query()->where('status', PlatformImpersonation::PENDING)
            ->where('ticket_expires_at', '<=', now())
            ->update(['status' => PlatformImpersonation::EXPIRED, 'updated_at' => now()]);

        return ['ended' => $ended, 'expired' => $expired];
    }

    /** `owner_name` of MeImpersonation: the tenant's first owner (read inside the tenant). */
    public function ownerName(Tenant $tenant): ?string
    {
        return $this->context->run($tenant, function () use ($tenant): ?string {
            $userId = TenantUser::query()->where('tenant_id', $tenant->id)->where('role', TenantUser::ROLE_OWNER)
                ->orderBy('created_at')->value('user_id');

            return $userId !== null ? User::query()->whereKey($userId)->value('name') : null;
        });
    }

    /** @return array{id: string, tenant_id: string, tenant_name: string, owner_name: string|null, reason: string, expires_at: string|null} */
    public function meShape(PlatformImpersonation $row): array
    {
        $tenant = Tenant::query()->findOrFail($row->target_tenant_id);

        return [
            'id' => $row->id,
            'tenant_id' => $tenant->id,
            'tenant_name' => $tenant->name,
            'owner_name' => $this->ownerName($tenant),
            'reason' => $row->reason,
            'expires_at' => $row->expires_at?->toIso8601ZuluString(),
        ];
    }

    /**
     * `User` as the merchant app sees it in an impersonation session: the staff user with `tenants` = only the target
     * tenant, role `owner` (the staff user's own memberships stay hidden, S72).
     *
     * @return array<string, mixed>
     */
    public function userShape(User $staff, PlatformImpersonation $row): array
    {
        $tenant = Tenant::query()->findOrFail($row->target_tenant_id);
        $user = (new UserResource($staff->withoutRelations()))->resolve();
        // PHASE-8-3 §6.2: impersonation = the owner set (still read-only, P8-10).
        $ownerRole = PlatformDb::connection()->table('roles')->where('tenant_id', $tenant->id)->where('key', TenantUser::ROLE_OWNER)->value('id');
        $user['tenants'] = [Memberships::owner($tenant, $ownerRole !== null ? (string) $ownerRole : null)];

        return $user;
    }

    public static function minutes(): int
    {
        return max(1, min(15, (int) config('admin.impersonation_minutes', 15)));
    }

    private function markExpired(PlatformImpersonation $row): void
    {
        PlatformImpersonation::query()->whereKey($row->id)->where('status', PlatformImpersonation::PENDING)
            ->update(['status' => PlatformImpersonation::EXPIRED, 'updated_at' => Carbon::now()]);
    }

    /** @param array<string, mixed> $meta */
    private function auditEnded(PlatformImpersonation $row, string $endedBy, ?User $actor, bool $system, array $meta): void
    {
        $tenant = Tenant::query()->find($row->target_tenant_id);
        if ($tenant === null) {
            return;
        }

        $this->context->run($tenant, fn () => $this->audit->log(self::ENDED, $row, [
            'impersonation_id' => $row->id,
            'ended_by' => $endedBy,
            'request_count' => (int) $row->request_count,
        ] + $meta, actor: $actor, tenantId: $tenant->id, system: $system, platform: $actor !== null ? true : null));
    }
}
