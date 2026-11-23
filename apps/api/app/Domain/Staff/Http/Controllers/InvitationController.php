<?php

namespace App\Domain\Staff\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Http\Requests\InviteStaffRequest;
use App\Domain\Staff\Http\Resources\StaffMemberPresenter;
use App\Domain\Staff\Mail\StaffInvitationMail;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Mail;

class InvitationController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    public function store(InviteStaffRequest $request): JsonResponse
    {
        $tenant = $this->context->tenant();
        $data = $request->validated();

        $alreadyMember = TenantUser::query()->forTenant($tenant->id)
            ->whereIn('user_id', User::query()->select('id')->where('email', $data['email']))
            ->exists();
        if ($alreadyMember) {
            throw new ApiException(409, 'already_member', 'This person is already a member of your shop.');
        }

        $existing = StaffInvitation::query()->open()->where('email', $data['email'])->first();
        if ($existing?->isUsable()) {
            throw new ApiException(409, 'invitation_pending', 'An invitation is already pending for this email.');
        }

        FeatureGate::assertWithin($tenant, Limit::StaffSeats);

        $token = StaffInvitation::newToken();

        $invitation = DB::transaction(function () use ($tenant, $existing, $data, $token, $request) {
            // Phase 7 (§2.2, S60): serialise invites per tenant (tenant row lock) and re-check the seat limit under it,
            // so two parallel invites at limit − 1 give one 201 and one 402.
            Tenant::query()->whereKey($tenant->id)->lockForUpdate()->first(['id']);
            FeatureGate::assertWithin($tenant, Limit::StaffSeats);
            // An expired open invitation would block the partial unique index: close it first.
            $existing?->update(['revoked_at' => now()]);

            return StaffInvitation::query()->create([
                'email' => $data['email'],
                'name' => $data['name'] ?? null,
                'role' => $data['role'],
                'token_hash' => StaffInvitation::hashToken($token),
                'invited_by' => $request->user()->getKey(),
                'expires_at' => now()->addDays(StaffInvitation::TTL_DAYS),
                'last_sent_at' => now(),
            ]);
        });

        $this->send($invitation, $token, $request->user());
        $this->audit->log('staff.invited', $invitation, ['role' => $invitation->role]);

        return new JsonResponse(['data' => StaffMemberPresenter::invitation($invitation->load('inviter'))], 201);
    }

    /** New token + fresh 7-day expiry; the old token stops working. */
    public function resend(Request $request, StaffInvitation $invitation): JsonResponse
    {
        Gate::authorize('manageInvitation', $invitation);
        $this->assertOpen($invitation);

        $token = StaffInvitation::newToken();
        $invitation->update([
            'token_hash' => StaffInvitation::hashToken($token),
            'expires_at' => now()->addDays(StaffInvitation::TTL_DAYS),
            'last_sent_at' => now(),
        ]);

        $this->send($invitation, $token, $request->user());
        $this->audit->log('staff.invitation_resent', $invitation);

        return new JsonResponse(['data' => StaffMemberPresenter::invitation($invitation->load('inviter'))]);
    }

    public function destroy(StaffInvitation $invitation): Response
    {
        Gate::authorize('manageInvitation', $invitation);
        $this->assertOpen($invitation);

        $invitation->update(['revoked_at' => now()]);
        $this->audit->log('staff.invitation_revoked', $invitation);

        return response()->noContent();
    }

    private function assertOpen(StaffInvitation $invitation): void
    {
        if (! $invitation->isOpen()) {
            throw new ApiException(409, 'invitation_not_pending', 'This invitation is no longer pending.');
        }
    }

    private function send(StaffInvitation $invitation, string $token, User $inviter): void
    {
        $shop = Store::query()->value('name') ?? $this->context->tenant()?->name ?? 'a shop';

        Mail::to($invitation->email)->queue(new StaffInvitationMail($token, $shop, $inviter->name, $invitation->role));
    }
}
