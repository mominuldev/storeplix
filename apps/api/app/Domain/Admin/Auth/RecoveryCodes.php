<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use App\Domain\Admin\Auth\Models\PlatformRecoveryCode;
use App\Domain\Identity\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-1 P8-4: 10 single-use recovery codes of 10 characters, shown once and stored as HMAC-SHA-256 (app key) so a
 * leaked table can't be brute-forced offline.
 */
final class RecoveryCodes
{
    public const COUNT = 10;

    public const LENGTH = 10;

    private const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

    /** @return list<string> the new plain codes (any previous codes are deleted) */
    public function regenerate(User $user): array
    {
        $codes = [];
        while (count($codes) < self::COUNT) {
            $code = '';
            for ($i = 0; $i < self::LENGTH; $i++) {
                $code .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
            }
            $codes[$code] = true;
        }
        $codes = array_keys($codes);

        DB::transaction(function () use ($user, $codes): void {
            PlatformRecoveryCode::query()->where('user_id', $user->id)->delete();
            foreach ($codes as $code) {
                PlatformRecoveryCode::query()->create(['user_id' => $user->id, 'code_hash' => self::hash($code)]);
            }
        });

        return $codes;
    }

    /** Marks a matching unused code as used; false for unknown or already used codes. */
    public function consume(User $user, string $code): bool
    {
        $normalized = strtolower((string) preg_replace('/[\s-]+/', '', $code));
        if (strlen($normalized) !== self::LENGTH) {
            return false;
        }

        return PlatformRecoveryCode::query()
            ->where('user_id', $user->id)
            ->where('code_hash', self::hash($normalized))
            ->whereNull('used_at')
            ->update(['used_at' => now()]) === 1;
    }

    public function remaining(User $user): int
    {
        return PlatformRecoveryCode::query()->where('user_id', $user->id)->whereNull('used_at')->count();
    }

    public function clear(User $user): void
    {
        PlatformRecoveryCode::query()->where('user_id', $user->id)->delete();
    }

    public static function hash(string $code): string
    {
        return hash_hmac('sha256', $code, (string) config('app.key'));
    }
}
