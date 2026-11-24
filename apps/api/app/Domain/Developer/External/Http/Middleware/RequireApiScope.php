<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Middleware;

use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `scope:<scope>` (PHASE-8-4 §3, S103): every external route declares exactly one (`scope:any` for
 * `/me`). Runs after `apikey` and after route-model binding, so ids of other tenants / stores answer 404 first.
 * Missing → 403 `api_key_scope_missing` with `details.required_scope`.
 */
class RequireApiScope
{
    public const ALIAS = 'scope';

    public const ANY = 'any';

    public function __construct(private readonly CurrentApiKey $current) {}

    public function handle(Request $request, Closure $next, string $scope): Response
    {
        $key = $this->current->get();
        if ($key === null) {
            throw new ApiException(401, 'invalid_api_key', 'The API key is missing, invalid or revoked.');
        }

        if ($scope !== self::ANY) {
            $required = ApiScope::tryFrom($scope) ?? throw new InvalidArgumentException("Unknown API scope [{$scope}] in scope middleware.");
            if (! $key->hasScope($required)) {
                throw new ApiException(403, 'api_key_scope_missing', 'This API key does not have the scope this request needs.', [
                    'required_scope' => [$required->value],
                ]);
            }
        }

        return $next($request);
    }
}
