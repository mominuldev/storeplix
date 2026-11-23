<?php

declare(strict_types=1);

namespace App\Domain\Identity\Support;

use Illuminate\Http\Request;

/**
 * PHASE-8-1 P8-1: every session carries the surface it was signed in on. Sessions written before Phase 8.1 have no
 * key and count as `merchant`.
 */
final class SessionSurface
{
    public const KEY = 'auth_surface';

    public const MERCHANT = 'merchant';

    public const ADMIN = 'admin';

    public const IMPERSONATION = 'impersonation';

    /** Session key holding the `platform_impersonations.id` of an impersonation session. */
    public const IMPERSONATION_KEY = 'impersonation_id';

    public static function of(Request $request): string
    {
        if (! $request->hasSession()) {
            return self::MERCHANT;
        }
        $surface = $request->session()->get(self::KEY);

        return is_string($surface) && in_array($surface, [self::ADMIN, self::IMPERSONATION], true) ? $surface : self::MERCHANT;
    }

    public static function set(Request $request, string $surface): void
    {
        $request->session()->put(self::KEY, $surface);
    }
}
