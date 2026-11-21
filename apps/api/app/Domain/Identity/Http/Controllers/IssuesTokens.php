<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use Illuminate\Http\JsonResponse;

/** Builds the AuthToken payload `{data:{token, expires_at, user}}`. */
trait IssuesTokens
{
    protected function tokenResponse(User $user, int $status = 200): JsonResponse
    {
        $expiresAt = now()->addMinutes((int) config('sanctum.expiration'));
        $token = $user->createToken('merchant-dashboard', ['*'], $expiresAt)->plainTextToken;

        return new JsonResponse([
            'data' => [
                'token' => $token,
                'expires_at' => $expiresAt->toIso8601ZuluString(),
                'user' => (new UserResource($user->load('tenants')))->resolve(),
            ],
        ], $status);
    }
}
