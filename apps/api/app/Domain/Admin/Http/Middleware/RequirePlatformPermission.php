<?php

declare(strict_types=1);

namespace App\Domain\Admin\Http\Middleware;

use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Route middleware `platform.can:<permission>` (PHASE-8-1 §2.1, S75). Runs after `platform`. */
class RequirePlatformPermission
{
    public function handle(Request $request, Closure $next, string $permission): Response
    {
        $role = PlatformRole::tryFrom((string) $request->user()?->platform_role);
        if ($role === null || ! $role->can(PlatformPermission::from($permission))) {
            throw new ApiException(403, 'forbidden', 'This action is not allowed.');
        }

        return $next($request);
    }
}
