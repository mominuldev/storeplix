<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use App\Domain\Identity\Models\User;
use Illuminate\Support\Facades\Cache;

/**
 * PHASE-8-1 §3.1 `login_token`: 32 random bytes (base64url) returned once; the cache holds only its SHA-256, for 5
 * minutes, bound to the user and the client IP. A token presented from another IP is treated as unknown.
 */
final class LoginTokens
{
    public const STEP_TOTP = 'totp';

    public const STEP_ENROLL = 'enroll';

    public const TTL_SECONDS = 300;

    /** @return array{0: string, 1: PendingLogin} the plain token and its pending login */
    public function issue(User $user, string $step, string $ip): array
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $pending = new PendingLogin(self::key($token), $user->id, $ip, $step, now()->addSeconds(self::TTL_SECONDS));
        $this->save($pending);

        return [$token, $pending];
    }

    public function find(?string $token, string $ip): ?PendingLogin
    {
        if ($token === null || $token === '' || strlen($token) > 128) {
            return null;
        }
        $data = Cache::get(self::key($token));
        $pending = is_array($data) ? PendingLogin::fromArray($data) : null;
        if ($pending === null || ! hash_equals($pending->ip, $ip) || $pending->expiresAt->isPast()) {
            return null;
        }

        return $pending;
    }

    public function save(PendingLogin $pending): void
    {
        Cache::put($pending->key, $pending->toArray(), $pending->expiresAt);
    }

    public function forget(PendingLogin $pending): void
    {
        Cache::forget($pending->key);
    }

    private static function key(string $token): string
    {
        return 'admin-login-token:'.hash('sha256', $token);
    }
}
