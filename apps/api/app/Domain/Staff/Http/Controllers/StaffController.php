<?php

namespace App\Domain\Staff\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Http\Resources\StaffMemberPresenter;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Staff\Roles\RoleService;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

class StaffController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
        private readonly RoleService $roles,
    ) {}

    /** Active members (owner first), then open invitations newest first. Not paginated. */
    public function index(Request $request): JsonResponse
    {
        Gate::authorize('viewAny', StaffInvitation::class);

        $tenant = $this->context->tenant();
        $me = $request->user()->getKey();

        $members = TenantUser::query()->forTenant($tenant->id)->with(['user', 'inviter', 'roleModel'])->get()
            ->sortBy(fn (TenantUser $m) => [$m->role === TenantUser::ROLE_OWNER ? 0 : 1, $m->created_at?->getTimestamp() ?? 0])
            ->map(fn (TenantUser $m) => StaffMemberPresenter::member($m, $me));

        $invitations = StaffInvitation::query()->open()->with(['inviter', 'roleModel'])->latest()->orderByDesc('id')->get()
            ->map(fn (StaffInvitation $i) => StaffMemberPresenter::invitation($i));

        return new JsonResponse([
            'data' => $members->values()->concat($invitations)->all(),
            'meta' => [
                'seats_used' => FeatureGate::usage($tenant, Limit::StaffSeats),
                'seats_limit' => FeatureGate::limit($tenant, Limit::StaffSeats),
            ],
        ]);
    }

    public function update(Request $request, TenantUser $member): JsonResponse
    {
        Gate::authorize('updateRole', $member);

        if ($member->user_id === $request->user()->getKey()) { // N7
            throw new ApiException(403, 'cannot_change_own_role', 'You cannot change your own role.');
        }
        // N8 before N6: the owner's membership is never changed (409, unchanged since Phase 2), whoever asks.
        if ($member->role === TenantUser::ROLE_OWNER) {
            throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
        }

        $data = $request->validate([
            'role' => ['required_without:role_id', 'prohibits:role_id', 'string', 'in:admin,staff'],
            'role_id' => ['required_without:role', 'string', 'max:26'],
        ]);
        // N9 / N5 on the target, N6 on the member's current role.
        $target = isset($data['role_id'])
            ? $this->roles->assignable($data['role_id'])
            : $this->roles->assignable($this->roles->systemRole(SystemRole::from($data['role']))->id, 'role');
        $this->roles->assertHoldsRole($member->role_id);                // N6 pre-check (fail closed, SEC-L5)

        // SEC-L3: lock the membership and both roles, then re-check N8, N6 and N5 on the locked rows.
        $member = DB::transaction(function () use ($member, $target) {
            // Tenant row first, like RoleService (same lock order → no deadlock with a concurrent role delete).
            Tenant::query()->whereKey($member->tenant_id)->lockForUpdate()->first(['id']);
            /** @var TenantUser $locked */
            $locked = TenantUser::query()->forTenant($member->tenant_id)->whereKey($member->getKey())->lockForUpdate()->firstOrFail();
            if ($locked->role === TenantUser::ROLE_OWNER) {
                throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
            }
            $current = $this->roles->assertHoldsRole($locked->role_id, lock: true);            // N6
            $lockedTarget = $this->roles->assertHoldsRole($target->id, lock: true)              // N5
                ?? throw ValidationException::withMessages(['role_id' => ['The selected role does not exist.']]);

            if ($current?->id !== $lockedTarget->id) {
                $fromId = $locked->role_id;
                $locked->update(['role_id' => $lockedTarget->id]);
                $this->audit->log('staff.role_changed', $locked, $current !== null
                    ? RoleService::roleChangeMeta($current, $lockedTarget)
                    : ['changes' => ['role' => ['from' => null, 'to' => $lockedTarget->name]], 'role_id' => ['from' => $fromId, 'to' => $lockedTarget->id]]);
            }

            return $locked;
        });

        return new JsonResponse(['data' => StaffMemberPresenter::member($member->load(['user', 'inviter', 'roleModel']), $request->user()->getKey())]);
    }

    /** Remove a member, or leave the shop when the member is yourself. The owner can never be removed. */
    public function destroy(Request $request, TenantUser $member): Response
    {
        Gate::authorize('remove', $member);

        if ($member->role === TenantUser::ROLE_OWNER) {
            throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
        }

        $self = $member->user_id === $request->user()->getKey();
        // N6: only members whose role the actor fully holds; a missing role fails closed (SEC-L5). Checked on the
        // locked membership and role rows (SEC-L3).
        DB::transaction(function () use ($member, $self) {
            Tenant::query()->whereKey($member->tenant_id)->lockForUpdate()->first(['id']);
            $locked = TenantUser::query()->forTenant($member->tenant_id)->whereKey($member->getKey())->lockForUpdate()->firstOrFail();
            if ($locked->role === TenantUser::ROLE_OWNER) {
                throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
            }
            if (! $self) {
                $this->roles->assertHoldsRole($locked->role_id, lock: true);
            }
            $locked->delete();
        });

        $this->audit->log($self ? 'staff.left' : 'staff.removed', $member, ['role' => $member->role]);

        return response()->noContent();
    }
}
