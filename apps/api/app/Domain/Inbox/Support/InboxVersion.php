<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * Polling without a websocket stack (PHASE-8-8E P88E-17, §12): cache counters through the tenant cache helper — one
 * per store (`inbox:v:{store}`, bumped after commit by every conversation / message change) and one per member
 * (`inbox:rv:{store}:{user}`, bumped when they read). ETag `W/"ix{store}.{read}.{hash}"`; a matching If-None-Match is
 * answered 304 before any Inbox query runs. Counters start at a millisecond clock so a cache flush never revives an
 * old ETag.
 */
final class InboxVersion
{
    public function __construct(private readonly TenantCache $cache) {}

    public function store(string $storeId): int
    {
        return (int) $this->cache->remember('inbox:v:'.$storeId, null, fn () => (int) floor(microtime(true) * 1000));
    }

    public function reader(string $storeId, string $userId): int
    {
        return (int) $this->cache->remember('inbox:rv:'.$storeId.':'.$userId, null, fn () => (int) floor(microtime(true) * 1000));
    }

    /** After the surrounding transaction commits (immediately outside one). */
    public function bump(string $storeId): void
    {
        DB::afterCommit(fn () => $this->cache->forever('inbox:v:'.$storeId, max($this->store($storeId) + 1, (int) floor(microtime(true) * 1000))));
    }

    public function bumpReader(string $storeId, string $userId): void
    {
        DB::afterCommit(fn () => $this->cache->forever('inbox:rv:'.$storeId.':'.$userId, max($this->reader($storeId, $userId) + 1, (int) floor(microtime(true) * 1000))));
    }

    /** @param list<string|int|null> $scope */
    public function etag(string $storeId, ?string $userId, array $scope): string
    {
        $read = $userId === null ? 0 : $this->reader($storeId, $userId);

        return 'W/"ix'.$this->store($storeId).'.'.$read.'.'.substr(hash('sha256', implode('|', array_map(fn ($v) => (string) $v, $scope))), 0, 16).'"';
    }

    public static function notModified(Request $request, string $etag): ?Response
    {
        $given = array_map('trim', explode(',', (string) $request->header('If-None-Match', '')));
        if (! in_array($etag, $given, true)) {
            return null;
        }

        return new Response('', 304, ['ETag' => $etag, 'Cache-Control' => 'private, no-cache']);
    }

    /** @param array<string, mixed> $payload */
    public static function respond(array $payload, string $etag): JsonResponse
    {
        return new JsonResponse($payload, 200, ['ETag' => $etag, 'Cache-Control' => 'private, no-cache']);
    }
}
