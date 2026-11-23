<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Admin\Auth\Totp;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use Illuminate\Testing\TestResponse;

/**
 * Phase 8.1 platform staff helpers (owner API-1; reusable by every admin/impersonation test).
 *  - staffUser(): a staff user with an enrolled TOTP secret (STAFF_SECRET), password `password`.
 *  - adminHeaders(): acting user + the admin SPA Referer; pair with asAdminSurface() for an admin-surface session
 *    (fast path, no sign-in). Use adminSignIn() (needs SpaBrowser with $spaOrigin = ADMIN_ORIGIN) for the real flow.
 */
trait PlatformStaffFixtures
{
    protected const STAFF_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    protected const ADMIN_ORIGIN = 'http://localhost:5174';

    /** @param array<string, mixed> $attributes */
    protected function staffUser(PlatformRole|string $role = PlatformRole::SuperAdmin, array $attributes = []): User
    {
        $user = User::factory()->create(array_intersect_key($attributes, array_flip(['name', 'email'])));
        $user->forceFill(array_merge([
            'platform_role' => $role instanceof PlatformRole ? $role->value : $role,
            'totp_secret' => self::STAFF_SECRET,
            'totp_confirmed_at' => now(),
        ], array_diff_key($attributes, array_flip(['name', 'email']))))->save();

        return $user->refresh();
    }

    /** @return array<string, string> */
    protected function adminHeaders(User $user): array
    {
        return ['X-Testing-User' => $user->id, 'Referer' => self::ADMIN_ORIGIN.'/', 'Accept' => 'application/json'];
    }

    /** Marks the test session as an admin-surface session (with a valid absolute and idle window). */
    protected function asAdminSurface(string $surface = SessionSurface::ADMIN): static
    {
        return $this->withSession([
            SessionSurface::KEY => $surface,
            EnforceAbsoluteSessionExpiry::KEY => now()->addHours(12)->getTimestamp(),
            EnforceAbsoluteSessionExpiry::LAST_SEEN_KEY => now()->getTimestamp(),
        ]);
    }

    protected function totpCode(string $secret = self::STAFF_SECRET): string
    {
        return app(Totp::class)->now($secret);
    }

    /** Real sign-in through the SPA browser (SpaBrowser): password, then the current TOTP code. */
    protected function adminSignIn(User $user, string $password = 'password'): TestResponse
    {
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $step = $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => $password])
            ->assertOk()->assertJsonPath('data.step', 'totp');

        return $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $step->json('data.login_token'), 'code' => $this->totpCode()])->assertOk();
    }
}
