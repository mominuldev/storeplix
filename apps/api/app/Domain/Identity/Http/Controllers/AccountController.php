<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Requests\ChangePasswordRequest;
use App\Domain\Identity\Http\Requests\UpdateProfileRequest;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class AccountController
{
    use IssuesTokens;

    public function __construct(private readonly AuditLogger $audit) {}

    public function update(UpdateProfileRequest $request): UserResource
    {
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

    /** Returns a NEW token; every other token (including the current one) is revoked. */
    public function changePassword(ChangePasswordRequest $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        DB::transaction(function () use ($user, $request) {
            $user->forceFill(['password' => $request->validated('password'), 'password_changed_at' => now()])->save();
            $user->tokens()->delete();
        });

        $this->audit->log('auth.password_changed', $user, tenantId: false);

        return $this->tokenResponse($user);
    }
}
