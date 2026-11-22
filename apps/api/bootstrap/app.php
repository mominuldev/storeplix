<?php

use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Http\Middleware\RequireStatefulRequest;
use App\Domain\Shared\Http\ApiExceptionRenderer;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
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
        ]);

        // Phase 4.7 (§7.2): same-origin cookie sessions for the SPAs (exact stateful domain list) with the absolute
        // 7-day session expiry. 4.7c: Bearer tokens are no longer read (AppServiceProvider) and sign-in is stateful-only.
        $middleware->statefulApi();
        $middleware->api(append: [EnforceAbsoluteSessionExpiry::class, SetDatabaseUser::class]);

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

        // API clients never get redirected to a login page.
        $middleware->redirectGuestsTo(fn (Request $request) => $request->is('api/*') ? null : '/');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        $exceptions->render(fn (Throwable $e, Request $request) => (new ApiExceptionRenderer)($e, $request));
    })->create();
