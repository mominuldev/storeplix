<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

/**
 * Cart-restore codes (P86-16): 10 base62 characters per run. The code is derived from the run id with an HMAC under
 * the app key (so both recovery messages carry the same working link) and only its sha256 is stored
 * (`automation_runs.recovery_code_hash`); the plaintext is never written anywhere.
 */
final class RecoveryCodes
{
    public const PATTERN = '/^[A-Za-z0-9]{10}$/';

    private const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

    public static function for(string $runId): string
    {
        $mac = hash_hmac('sha256', 'automation-recovery:'.strtolower($runId), (string) config('app.key'), true);
        $code = '';
        for ($i = 0; $i < 10; $i++) {
            $code .= self::ALPHABET[ord($mac[$i]) % 62];
        }

        return $code;
    }

    public static function hash(string $code): string
    {
        return hash('sha256', $code);
    }

    public static function valid(string $code): bool
    {
        return preg_match(self::PATTERN, $code) === 1;
    }
}
