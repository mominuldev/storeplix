<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use App\Domain\Admin\Auth\Http\Resources\PlatformUserResource;
use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Admin-surface sessions (PHASE-8-1 P8-1, P8-5, §3.1 step 4): regenerate, `surface: admin`, absolute expiry
 * (`admin.session_absolute_hours`) and the idle marker (`admin.session_idle_minutes`).
 */
final class AdminSessions
{
    public function start(Request $request, User $user): void
    {
        Auth::guard('web')->login($user);
        $request->session()->regenerate();
        SessionSurface::set($request, SessionSurface::ADMIN);
        $request->session()->put(EnforceAbsoluteSessionExpiry::KEY, now()->addHours(max(1, (int) config('admin.session_absolute_hours', 12)))->getTimestamp());
        $request->session()->put(EnforceAbsoluteSessionExpiry::LAST_SEEN_KEY, now()->getTimestamp());
    }

    /** @return array{user: array<string, mixed>, session_expires_at: string|null, idle_expires_at: string|null} openapi `AdminSession` */
    public function payload(Request $request, User $user): array
    {
        $absolute = $request->session()->get(EnforceAbsoluteSessionExpiry::KEY);
        $lastSeen = $request->session()->get(EnforceAbsoluteSessionExpiry::LAST_SEEN_KEY);
        $idle = is_int($lastSeen) ? $lastSeen + EnforceAbsoluteSessionExpiry::adminIdleSeconds() : null;
        if (is_int($absolute) && is_int($idle)) {
            $idle = min($idle, $absolute);
        }

        return [
            'user' => (new PlatformUserResource($user))->resolve($request),
            'session_expires_at' => is_int($absolute) ? Carbon::createFromTimestamp($absolute)->toIso8601ZuluString() : null,
            'idle_expires_at' => is_int($idle) ? Carbon::createFromTimestamp($idle)->toIso8601ZuluString() : null,
        ];
    }

    /**
     * Deletes the user's admin-surface sessions only (PHASE-8-1 §5.1 `sessions`): the surface lives in the payload, so
     * merchant sessions of the same user survive. Only the database session driver can be enumerated; with any other
     * driver the `platform` middleware still refuses the disabled user on the next request.
     *
     * @return int sessions deleted
     */
    public function killAdminSessions(User $user): int
    {
        if (config('session.driver') !== 'database') {
            return 0;
        }
        $table = (string) config('session.table', 'sessions');
        $connection = DB::connection(config('session.connection'));
        $ids = [];
        foreach ($connection->table($table)->where('user_id', $user->id)->get(['id', 'payload']) as $row) {
            if (self::surfaceOf((string) $row->payload) === SessionSurface::ADMIN) {
                $ids[] = $row->id;
            }
        }

        return $ids === [] ? 0 : $connection->table($table)->whereIn('id', $ids)->delete();
    }

    private static function surfaceOf(string $payload): ?string
    {
        $data = base64_decode($payload, true);
        if ($data === false) {
            return null;
        }
        if (config('session.encrypt')) {
            try {
                $data = app('encrypter')->decrypt($data, false);
            } catch (\Throwable) {
                return null;
            }
        }
        $session = config('session.serialization', 'php') === 'json'
            ? json_decode((string) $data, true)
            : @unserialize((string) $data, ['allowed_classes' => false]);

        return is_array($session) && is_string($session[SessionSurface::KEY] ?? null) ? $session[SessionSurface::KEY] : null;
    }
}
