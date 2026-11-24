<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Authorization;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `perm` (PHASE-8-3 P83-4, S91): every route behind `tenant` declares exactly one
 * `perm:<key>[|<key>…]` (any of) or `perm:base` (every member). Runs after `tenant` and after route-model binding,
 * so ids of other tenants / stores still answer 404. Denied → 403 `forbidden`.
 *
 * PHASE-8-5 §2.1: `perm:a,b` (comma = Laravel middleware parameters) requires EVERY listed spec (each spec still
 * `x|y` = any of), e.g. campaign recipients `perm:marketing.manage,customers.view`.
 */
class RequirePermission
{
    public const ALIAS = 'perm';

    public const BASE = 'base';

    public function __construct(private readonly TenantContext $context) {}

    public function handle(Request $request, Closure $next, string ...$specs): Response
    {
        if (! $this->context->has()) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        }

        foreach ($specs as $spec) {
            if ($spec !== self::BASE && ! $this->context->allowsAny(...self::parse($spec))) {
                throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
            }
        }

        return $next($request);
    }

    /** @return list<Permission> every key named by the spec (`,`-joined specs are flattened; used to validate route specs) */
    public static function parse(string $spec): array
    {
        if ($spec === self::BASE) {
            return [];
        }

        return array_map(
            fn (string $key) => Permission::tryFrom($key) ?? throw new InvalidArgumentException("Unknown permission [{$key}] in perm middleware."),
            preg_split('/[|,]/', $spec) ?: [],
        );
    }
}
