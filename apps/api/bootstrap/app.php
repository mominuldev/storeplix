<?php

use App\Domain\Admin\Http\Middleware\PlatformIpAllowlist;
use App\Domain\Admin\Http\Middleware\RequirePlatformPermission;
use App\Domain\Admin\Http\Middleware\RequirePlatformStaff;
use App\Domain\Admin\Impersonation\Http\ReadOnlyImpersonation;
use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Http\Middleware\RequireStatefulRequest;
use App\Domain\Identity\Http\Middleware\RequireSurface;
use App\Domain\Shared\Http\ApiExceptionRenderer;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Tenancy\Authorization\RequirePermission;
use App\Domain\Tenancy\Middleware\ResetDatabaseTenant;
use App\Domain\Tenancy\Middleware\ResolveTenant;
use App\Domain\Tenancy\Middleware\SetDatabaseUser;
use Illuminate\Contracts\Auth\Middleware\AuthenticatesRequests;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\SubstituteBindings;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'tenant' => ResolveTenant::class,
            'storefront' => ResolveStorefront::class,
            'stateful' => RequireStatefulRequest::class,
            // Phase 8.1 (PHASE-8-1 P8-1, §2.1, P8-19)
            'surface' => RequireSurface::class,
            'platform' => RequirePlatformStaff::class,
            'platform.can' => RequirePlatformPermission::class,
            'platform.ip' => PlatformIpAllowlist::class,
            // Phase 8.3 (PHASE-8-3 P83-4): `perm:<key>|…` / `perm:base` on every tenant route
            'perm' => RequirePermission::class,
        ]);

        // Phase 4.7 (§7.2): same-origin cookie sessions for the SPAs (exact stateful domain list) with the absolute
        // 7-day session expiry. 4.7c: Bearer tokens are no longer read (AppServiceProvider) and sign-in is stateful-only.
        $middleware->statefulApi();
        $middleware->api(append: [ReadOnlyImpersonation::class, EnforceAbsoluteSessionExpiry::class, SetDatabaseUser::class]); // P8-10: ReadOnlyImpersonation before the session expiry (owner API-3)

        // Phase 5b (RLS, PHASE-5B-CONTRACT §2.5): empty app.tenant_id / app.user_id at the start of every request;
        // app.user_id right after auth:sanctum (before ResolveTenant looks up the membership).
        $middleware->prepend(ResetDatabaseTenant::class);
        $middleware->appendToPriorityList(AuthenticatesRequests::class, SetDatabaseUser::class);

        // X-Forwarded-* from the Nginx / Vite proxy in front of the API (comma-separated IPs/CIDRs, or "*").
        $trusted = array_values(array_filter(array_map('trim', explode(',', (string) env('TRUSTED_PROXIES', '')))));
        if ($trusted !== []) {
            $middleware->trustProxies(at: $trusted === ['*'] ? '*' : $trusted);
        }

        // Tenant context must exist before route-model binding runs tenant-scoped queries.
        $middleware->prependToPriorityList(SubstituteBindings::class, ResolveTenant::class);
        $middleware->prependToPriorityList(SubstituteBindings::class, ResolveStorefront::class);

        // Phase 8.1 (P8-1, S67/S68/S75): the session surface is checked before the tenant lookup, and every platform
        // check runs before route-model binding, so a refused caller never learns whether an id exists (403, not 404).
        $middleware->prependToPriorityList(ResolveTenant::class, RequireSurface::class);
        $middleware->prependToPriorityList(SubstituteBindings::class, RequirePlatformStaff::class);
        $middleware->prependToPriorityList(SubstituteBindings::class, PlatformIpAllowlist::class);
        $middleware->prependToPriorityList(SubstituteBindings::class, RequirePlatformPermission::class);

        // Phase 8.3 (P83-4): permissions are checked after the tenant AND after route-model binding (foreign ids → 404).
        $middleware->appendToPriorityList(SubstituteBindings::class, RequirePermission::class);

        // API clients never get redirected to a login page.
        $middleware->redirectGuestsTo(fn (Request $request) => $request->is('api/*') ? null : '/');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        $exceptions->render(fn (Throwable $e, Request $request) => (new ApiExceptionRenderer)($e, $request));
    })->create();
