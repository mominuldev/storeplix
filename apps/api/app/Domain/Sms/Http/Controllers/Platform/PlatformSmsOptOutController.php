<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers\Platform;

use App\Domain\Identity\Models\User;
use App\Domain\Sms\Broadcasts\PlatformSmsOptOut;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-9B §7.6, §9.2: the public opt-out link (`GET|POST /platform-sms/opt-out/{code}`, limiter 30/min per IP; GET
 * never changes anything) and the signed-in user's own `GET|PATCH /account/sms-preferences` (no tenant; impersonation
 * sessions are read-only → 403 on PATCH).
 */
class PlatformSmsOptOutController
{
    private const HEADERS = ['Cache-Control' => 'no-store', 'X-Robots-Tag' => 'noindex'];

    public function __construct(private readonly PlatformSmsOptOut $optOut) {}

    public function show(string $code): JsonResponse
    {
        return new JsonResponse(['data' => $this->optOut->lookup($code)], 200, self::HEADERS);
    }

    public function store(string $code): JsonResponse
    {
        return new JsonResponse(['data' => $this->optOut->optOut($code)], 200, self::HEADERS);
    }

    public function preferences(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return new JsonResponse(['data' => PlatformSmsOptOut::preferences($user)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function updatePreferences(Request $request): JsonResponse
    {
        $input = $request->validate(['promotional' => ['required', 'boolean']]);
        /** @var User $user */
        $user = $request->user();

        return new JsonResponse(['data' => $this->optOut->update($user, (bool) $input['promotional'])], 200, ['Cache-Control' => 'private, no-store']);
    }
}
