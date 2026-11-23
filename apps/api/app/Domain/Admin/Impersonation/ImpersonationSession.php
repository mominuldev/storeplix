<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation;

use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * The impersonation behind the current merchant-origin request (PHASE-8-1 P8-10, S74). Reads `platform_impersonations`
 * (platform table) on the app connection, once per request (cached on the request). A row that is gone, not active,
 * past `expires_at`, belongs to another user, or whose staff user lost `impersonate` ends the row (expiry / revoked),
 * signs the session out and answers **401 `impersonation_ended`**.
 */
final class ImpersonationSession
{
    private const ATTRIBUTE = 'platform_impersonation';

    public function __construct(private readonly ImpersonationService $service) {}

    public static function isImpersonating(Request $request): bool
    {
        return SessionSurface::of($request) === SessionSurface::IMPERSONATION;
    }

    /** @throws ApiException 401 impersonation_ended */
    public function current(Request $request): PlatformImpersonation
    {
        $cached = $request->attributes->get(self::ATTRIBUTE);
        if ($cached instanceof PlatformImpersonation) {
            return $cached;
        }

        $id = $request->session()->get(SessionSurface::IMPERSONATION_KEY);
        $row = is_string($id) ? PlatformImpersonation::query()->find($id) : null;
        $userId = Auth::guard('web')->id();

        if ($row === null || $userId === null || (string) $userId !== $row->staff_user_id) {
            $this->signOut($request);
        }

        if ($row->status === PlatformImpersonation::ACTIVE && ! $row->isLive()) {
            $this->service->end($row, PlatformImpersonation::ENDED_BY_EXPIRY, system: true);
        } elseif ($row->status === PlatformImpersonation::ACTIVE
            && ! ImpersonationService::staffMayImpersonate(User::query()->find($row->staff_user_id))) {
            $this->service->end($row, PlatformImpersonation::ENDED_BY_REVOKED, system: true);
        }

        if ($row->status !== PlatformImpersonation::ACTIVE) {
            $this->signOut($request);
        }

        $request->attributes->set(self::ATTRIBUTE, $row);

        return $row;
    }

    /** POST /auth/logout in an impersonation session: the row ends as `staff` (if still active). */
    public function endOnLogout(Request $request): void
    {
        $id = $request->session()->get(SessionSurface::IMPERSONATION_KEY);
        $row = is_string($id) ? PlatformImpersonation::query()->find($id) : null;
        if ($row !== null && (string) Auth::guard('web')->id() === $row->staff_user_id) {
            $this->service->end($row, $row->isLive() ? PlatformImpersonation::ENDED_BY_STAFF : PlatformImpersonation::ENDED_BY_EXPIRY);
        }
    }

    public function signOut(Request $request): never
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        throw new ApiException(401, 'impersonation_ended', 'This impersonation session has ended.');
    }
}
