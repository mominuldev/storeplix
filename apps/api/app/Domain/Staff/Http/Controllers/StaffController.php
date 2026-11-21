<?php

namespace App\Domain\Staff\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Http\Resources\StaffMemberPresenter;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

class StaffController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** Active members (owner first), then open invitations newest first. Not paginated. */
    public function index(Request $request): JsonResponse
    {
        Gate::authorize('viewAny', StaffInvitation::class);

        $tenant = $this->context->tenant();
        $me = $request->user()->getKey();

        $members = TenantUser::query()->forTenant($tenant->id)->with(['user', 'inviter'])->get()
            ->sortBy(fn (TenantUser $m) => [$m->role === TenantUser::ROLE_OWNER ? 0 : 1, $m->created_at?->getTimestamp() ?? 0])
            ->map(fn (TenantUser $m) => StaffMemberPresenter::member($m, $me));

        $invitations = StaffInvitation::query()->open()->with('inviter')->latest()->orderByDesc('id')->get()
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

        $data = $request->validate(['role' => ['required', 'string', 'in:admin,staff']]);

        if ($member->user_id === $request->user()->getKey()) {
            throw new ApiException(403, 'cannot_change_own_role', 'You cannot change your own role.');
        }
        if ($member->role === TenantUser::ROLE_OWNER) {
            throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
        }

        $from = $member->role;
        if ($from !== $data['role']) {
            $member->update(['role' => $data['role']]);
            $this->audit->log('staff.role_changed', $member, ['changes' => ['role' => ['from' => $from, 'to' => $data['role']]]]);
        }

        return new JsonResponse(['data' => StaffMemberPresenter::member($member->load(['user', 'inviter']), $request->user()->getKey())]);
    }

    /** Remove a member, or leave the shop when the member is yourself. The owner can never be removed. */
    public function destroy(Request $request, TenantUser $member): Response
    {
        Gate::authorize('remove', $member);

        if ($member->role === TenantUser::ROLE_OWNER) {
            throw new ApiException(409, 'last_owner', 'The shop owner cannot be demoted or removed.');
        }

        $self = $member->user_id === $request->user()->getKey();
        $member->delete();

        $this->audit->log($self ? 'staff.left' : 'staff.removed', $member, ['role' => $member->role]);

        return response()->noContent();
    }
}
