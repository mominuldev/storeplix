<?php

declare(strict_types=1);

namespace App\Domain\Admin\Http\Middleware;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\IpUtils;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `platform.ip` (PHASE-8-1 P8-19): `ADMIN_IP_ALLOWLIST` (CIDRs; empty = off) → 403 `forbidden` and the
 * platform audit row `admin.ip_blocked`, once per IP per hour. Owner: API-1.
 */
class PlatformIpAllowlist
{
    public function handle(Request $request, Closure $next): Response
    {
        $allow = (array) config('admin.ip_allowlist', []);
        $ip = (string) $request->ip();
        if ($allow !== [] && ! IpUtils::checkIp($ip, $allow)) {
            if (Cache::add('admin-ip-blocked:'.hash('sha256', $ip), true, now()->addHour())) {
                app(AuditLogger::class)->log('admin.ip_blocked', meta: ['path' => '/'.ltrim($request->path(), '/')], tenantId: false);
            }

            throw new ApiException(403, 'forbidden', 'This action is not allowed.');
        }

        return $next($request);
    }
}
