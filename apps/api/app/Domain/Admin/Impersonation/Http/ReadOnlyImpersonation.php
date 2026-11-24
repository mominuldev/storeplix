<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Global on the `api` group, before `EnforceAbsoluteSessionExpiry` (PHASE-8-1 P8-10, S71, S74). Inert unless the
 * request carries a session whose surface is `impersonation`. On `tenant` routes the same checks already ran in
 * ResolveTenant (the priority list sorts it before every group middleware). Then:
 *
 * 1. The session must still be live (ImpersonationSession): expired, ended, revoked, or the staff user lost
 *    `impersonate` → 401 `impersonation_ended`, session invalidated. Skipped for `POST /auth/impersonation` (a new
 *    ticket replaces the session) and `POST /auth/logout` (ends the row as `staff`, then signs out).
 * 2. Every method other than GET / HEAD / OPTIONS → 403 `impersonation_read_only`, except `POST /auth/logout`,
 *    `DELETE /auth/impersonation` and `POST /auth/impersonation`. This runs before route bindings (here or in
 *    ResolveTenant), policies and validation, so a new write route is refused by default (ImpersonationTest builds
 *    its dataset from the live route list).
 * 3. GET routes with side effects:
 *    - `GET /billing/payments/{payment}`: the controller skips the provider status query in an impersonation session
 *      and answers from the database (BillingInvoiceController::payment).
 *    - `dev/*` (testing-only routes, all POST today): refused here whatever the method → 403 `impersonation_read_only`.
 *    - `GET /stores/{store}/expenses/{expense}/receipt` (PHASE-8-7 P87-8): the controller answers 403
 *      `impersonation_receipt_hidden` (impersonators see amounts, never receipt documents; ExpenseReceiptController::link).
 *    Reviewed and left readable: `couriers/{provider}/areas` and `couriers/{provider}/pickup-stores` (provider lookups
 *    with the merchant's credentials, no write), invoice PDF / document / export downloads (reads), the expenses CSV
 *    export `GET /stores/{store}/expenses/export` (a read, audited with the impersonation actor).
 */
class ReadOnlyImpersonation
{
    private const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

    public function __construct(private readonly ImpersonationSession $sessions) {}

    public function handle(Request $request, Closure $next): Response
    {
        if (! $request->hasSession() || ! ImpersonationSession::isImpersonating($request)) {
            return $next($request);
        }

        if ($request->routeIs('auth.impersonation.store')) {
            return $next($request);
        }

        if ($request->routeIs('auth.logout')) {
            $this->sessions->endOnLogout($request);

            return $next($request);
        }

        $this->sessions->current($request);

        if ($request->routeIs('auth.impersonation.destroy')) {
            return $next($request);
        }

        self::assertReadOnly($request);

        return $next($request);
    }

    /**
     * The refusal itself. Also called by ResolveTenant (impersonation branch): the route-middleware priority list runs
     * `tenant` and SubstituteBindings before this group middleware, and the refusal must come before route bindings
     * and before the request counter is bumped.
     *
     * @throws ApiException 403 impersonation_read_only
     */
    public static function assertReadOnly(Request $request): void
    {
        if (! in_array($request->getMethod(), self::READ_METHODS, true) || $request->routeIs('dev.*')) {
            throw new ApiException(403, 'impersonation_read_only', 'This is a read-only impersonation session. Changes are disabled.');
        }
    }
}
