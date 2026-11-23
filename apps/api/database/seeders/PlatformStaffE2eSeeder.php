<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Admin\Auth\Models\PlatformRecoveryCode;
use App\Domain\Admin\Auth\RecoveryCodes;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use RuntimeException;

/**
 * Playwright fixture for the admin sign-in (PHASE-8-1 §10 QA `phase8.admin-auth`). NOT called from DatabaseSeeder;
 * refuses to run outside APP_ENV local/testing. Run: `php artisan db:seed --class=PlatformStaffE2eSeeder`.
 *
 * Super admin:   e2e-superadmin@storeplix.com / password
 * TOTP secret:   JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP (base32, SHA-1, 6 digits, 30 s; compute codes in the spec, e.g. with
 *                `otpauth` / `otplib`). The seeder resets `totp_last_step`, so the current code works right after seeding.
 * Recovery codes: e2ecode001 … e2ecode010 (all unused after every run).
 *
 * Idempotent: re-running clears a lock-out, re-enables the user and restores the secret and codes.
 */
class PlatformStaffE2eSeeder extends Seeder
{
    public const EMAIL = 'e2e-superadmin@storeplix.com';

    public const PASSWORD = 'password';

    public const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    public function run(): void
    {
        if (! app()->environment(['local', 'testing'])) {
            throw new RuntimeException('PlatformStaffE2eSeeder only runs with APP_ENV local or testing.');
        }

        $user = User::query()->firstOrNew(['email' => self::EMAIL]);
        // password_changed_at only on create: bumping it ends every live session of this shared fixture user, so a
        // re-seed from one spec (lock reset) would sign out specs running alongside it.
        $user->fill(['name' => 'E2E Super Admin', 'email_verified_at' => now()]);
        if (! $user->exists || ! Hash::check(self::PASSWORD, (string) $user->password)) {
            $user->fill(['password' => self::PASSWORD, 'password_changed_at' => now()]);
        }
        $user->forceFill([
            'platform_role' => PlatformRole::SuperAdmin->value,
            'platform_disabled_at' => null,
            'platform_locked_until' => null,
            'totp_secret' => self::TOTP_SECRET,
            'totp_confirmed_at' => now(),
            'totp_last_step' => null,
        ])->save();

        PlatformRecoveryCode::query()->where('user_id', $user->id)->delete();
        for ($i = 1; $i <= 10; $i++) {
            PlatformRecoveryCode::query()->create([
                'user_id' => $user->id,
                'code_hash' => RecoveryCodes::hash(sprintf('e2ecode%03d', $i)),
            ]);
        }
    }
}
