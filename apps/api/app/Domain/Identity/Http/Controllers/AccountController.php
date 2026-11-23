<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Requests\ChangePasswordRequest;
use App\Domain\Identity\Http\Requests\UpdateProfileRequest;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class AccountController
{
    use IssuesTokens;

    public function __construct(private readonly AuditLogger $audit) {}

    public function update(UpdateProfileRequest $request): UserResource
    {
        self::requireMerchantSurface($request);
        /** @var User $user */
        $user = $request->user();
        $data = collect($request->validated())->only(['name', 'email', 'phone'])->all();

        $user->fill($data);

        if ($user->isDirty('phone')) {
            $user->phone_verified_at = null; // a new number must be re-verified
        }
        if ($user->isDirty('email')) {
            $user->email_verified_at = null;
        }

        $changes = array_keys($user->getDirty());
        $user->save();

        if ($changes !== []) {
            $this->audit->log('account.profile_updated', $user, ['changes' => array_values(array_intersect($changes, ['name', 'email', 'phone']))], tenantId: false);
        }

        return new UserResource($user->load('tenants'));
    }

    /** Rotates the current session; every other session dies on its next request (AuthenticateSession hash check). */
    public function changePassword(ChangePasswordRequest $request): JsonResponse
    {
        self::requireMerchantSurface($request);
        /** @var User $user */
        $user = $request->user();

        DB::transaction(function () use ($user, $request) {
            $user->forceFill(['password' => $request->validated('password'), 'password_changed_at' => now()])->save();
        });

        $this->audit->log('auth.password_changed', $user, tenantId: false);

        return $this->sessionResponse($user);
    }

    /**
     * PHASE-8-1 P8-1: account changes belong to the merchant surface. An admin session must not rotate itself into a
     * 7-day merchant session (changePassword re-issues the session) or move a staff email outside ADMIN_EMAIL_DOMAINS.
     */
    private static function requireMerchantSurface(Request $request): void
    {
        if (SessionSurface::of($request) !== SessionSurface::MERCHANT) {
            throw new ApiException(403, 'forbidden', 'This action is not available in this session.');
        }
    }
}
