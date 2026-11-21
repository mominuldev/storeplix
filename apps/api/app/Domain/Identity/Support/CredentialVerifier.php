<?php

namespace App\Domain\Identity\Support;

use App\Domain\Identity\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Constant-work password checks (QA M-1): when the account doesn't exist we still verify the
 * password against a dummy hash made with the CURRENT hasher settings, so "unknown email"
 * and "wrong password" take the same time.
 */
final class CredentialVerifier
{
    public static function check(?User $user, string $password): bool
    {
        if ($user === null) {
            Hash::check($password, self::dummyHash());

            return false;
        }

        return Hash::check($password, $user->password);
    }

    public static function dummyHash(): string
    {
        $key = 'identity:timing-dummy-hash:'.config('hashing.driver').':'.md5((string) json_encode([config('hashing.argon'), config('hashing.bcrypt')]));

        return Cache::rememberForever($key, fn () => Hash::make(Str::random(40)));
    }
}
