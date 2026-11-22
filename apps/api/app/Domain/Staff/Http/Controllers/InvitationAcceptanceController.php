<?php

namespace App\Domain\Staff\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Identity\Http\Controllers\IssuesTokens;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Http\Requests\AcceptInvitationRequest;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PreTenantLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Public invitation endpoints. The invitee is not a member yet, so there is no X-Tenant-Id:
 * the tenant comes from the (hashed) token (PreTenantLookup, B4), then everything runs inside that tenant.
 */
class InvitationAcceptanceController
{
    use IssuesTokens;

    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
        private readonly PreTenantLookup $preTenant,
    ) {}

    public function show(string $token): JsonResponse
    {
        $tenantId = $this->tenantFor($token);

        return $this->context->run($tenantId, function () use ($token) {
            $invitation = $this->findUsable($token);
            $tenant = Tenant::query()->findOrFail($invitation->tenant_id);

            return new JsonResponse(['data' => [
                'tenant_name' => $tenant->name,
                'store_name' => Store::query()->value('name'),
                'email' => $invitation->email,
                'role' => $invitation->role,
                'invited_by_name' => (string) $invitation->inviter?->name,
                'expires_at' => $invitation->expires_at->toIso8601ZuluString(),
                'user_exists' => User::query()->where('email', $invitation->email)->exists(),
            ]]);
        });
    }

    public function accept(Request $request, string $token): JsonResponse
    {
        /** @var User|null $authUser */
        $authUser = Auth::guard('sanctum')->user();

        // B4 (Phase 5b): the token resolves the tenant (a definer function under RLS); everything else, including the
        // row lock, runs scoped inside that tenant. The transaction opens INSIDE run(): no tenant switch within it.
        [$user, $membership, $tenant] = $this->context->run($this->tenantFor($token), function () use ($token, $authUser) {
            $user = null;
            $data = [];
            $invitation = $this->findUsable($token);
            $tenant = Tenant::query()->findOrFail($invitation->tenant_id);

            if ($authUser !== null) {
                if (strtolower($authUser->email) !== $invitation->email) {
                    throw new ApiException(403, 'invitation_email_mismatch', 'This invitation was sent to a different email address.');
                }
                $user = $authUser;
            } else {
                if (User::query()->where('email', $invitation->email)->exists()) {
                    throw new ApiException(409, 'login_required', 'An account already exists for this email. Sign in to accept.');
                }
                $data = app(AcceptInvitationRequest::class)->validated();
            }

            if ($user !== null && TenantUser::query()->forTenant($tenant->id)->where('user_id', $user->id)->exists()) {
                throw new ApiException(409, 'already_member', 'You are already a member of this shop.');
            }

            // Seats re-checked: the pending invitation already occupies a seat, so it converts 1:1.
            FeatureGate::assertWithin($tenant, Limit::StaffSeats, adding: 0);

            [$user, $membership] = DB::transaction(function () use ($invitation, $tenant, $user, $data) {
                $locked = StaffInvitation::query()->whereKey($invitation->id)->lockForUpdate()->first();
                if ($locked === null || ! $locked->isUsable()) {
                    throw new ApiException(404, 'invitation_invalid', 'This invitation is invalid or has expired.');
                }

                $user ??= User::query()->create([
                    'name' => $data['name'],
                    'email' => $invitation->email,
                    'phone' => $data['phone'] ?? null,
                    'password' => $data['password'],
                    'email_verified_at' => now(),
                    'password_changed_at' => now(),
                ]);

                $membership = TenantUser::query()->create([
                    'tenant_id' => $tenant->id,
                    'user_id' => $user->id,
                    'role' => $invitation->role,
                    'invited_by' => $invitation->invited_by,
                    'joined_at' => now(),
                ]);

                $locked->update(['accepted_at' => now(), 'accepted_user_id' => $user->id]);

                return [$user, $membership];
            });

            $this->audit->log('staff.joined', $membership, ['role' => $membership->role], actor: $user, tenantId: $tenant->id);

            return [$user, $membership, $tenant];
        });

        if ($authUser !== null) {
            return new JsonResponse(['data' => ['id' => $tenant->id, 'name' => $tenant->name, 'role' => $membership->role]]);
        }

        return $this->sessionResponse($user, 201);
    }

    /** B4: the tenant of a token, before any tenant context exists (unknown token → the same 404). */
    private function tenantFor(string $token): string
    {
        $found = strlen($token) <= 128 ? $this->preTenant->invitationByTokenHash(StaffInvitation::hashToken($token)) : null;

        if ($found === null) {
            throw new ApiException(404, 'invitation_invalid', 'This invitation is invalid or has expired.');
        }

        return $found['tenant_id'];
    }

    /** Inside the invitation's tenant: the scoped row, usable or 404. */
    private function findUsable(string $token): StaffInvitation
    {
        $invitation = StaffInvitation::query()->with('inviter')->where('token_hash', StaffInvitation::hashToken($token))->first();

        if ($invitation === null || ! $invitation->isUsable()) {
            throw new ApiException(404, 'invitation_invalid', 'This invitation is invalid or has expired.');
        }

        return $invitation;
    }
}
