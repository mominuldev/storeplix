<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http;

use App\Domain\Stores\Services\HostNormalizer;
use App\Domain\Tenancy\Support\PreTenantLookup;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * P6-17 / roadmap 6.5: `GET /api/v1/internal/domains/allowed?domain=&key=` for Caddy on-demand TLS (`ask`). No tenant
 * header, no session. Shared key (constant-time; empty config → always 401). Every not-allowed host (unknown,
 * malformed, pending, failed, expired, suspended) gets the same byte-identical 404. The key is never logged.
 */
class DomainAskController
{
    public function __invoke(Request $request, PreTenantLookup $lookup): JsonResponse
    {
        $expected = (string) config('domains.ask_key');
        $given = $request->query('key');
        if ($expected === '' || ! is_string($given) || ! hash_equals($expected, $given)) {
            return self::json(['error' => ['code' => 'unauthenticated', 'message' => 'Unauthenticated.']], 401);
        }

        $raw = $request->query('domain');
        $host = is_string($raw) && strlen($raw) <= 253 ? HostNormalizer::normalize($raw) : null;
        if ($host === null || ! $lookup->domainAllowed($host)) {
            return self::json(['error' => ['code' => 'domain_not_allowed', 'message' => 'This domain is not allowed.']], 404);
        }

        return self::json(['data' => ['allowed' => true]], 200);
    }

    /** @param array<string, mixed> $body */
    private static function json(array $body, int $status): JsonResponse
    {
        return new JsonResponse($body, $status, ['Cache-Control' => 'no-store']);
    }
}
