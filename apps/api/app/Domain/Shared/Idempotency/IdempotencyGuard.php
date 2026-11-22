<?php

namespace App\Domain\Shared\Idempotency;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\ResolvedStorefront;
use Closure;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `idempotent:{scope}` (P5-14, §7). The key row is inserted as `processing` in its own short
 * transaction BEFORE the business transaction; a 2xx response is stored (encrypted) and replayed for the same key and
 * body with `Idempotent-Replayed: true`; any other outcome deletes the row so the client can retry with the same key.
 * Same key + different body → 409 idempotency_key_mismatch; in flight → 409 idempotency_key_in_use; a `processing`
 * row past `locked_until` is taken over. Keys live 24 h (idempotency:prune).
 */
class IdempotencyGuard
{
    public const HEADER = 'Idempotency-Key';

    public const LOCK_SECONDS = 30;

    public const TTL_HOURS = 24;

    public function handle(Request $request, Closure $next, string $scope): Response
    {
        $key = (string) $request->header(self::HEADER, '');
        if ($key === '') {
            throw new ApiException(400, 'idempotency_key_required', 'Send an Idempotency-Key header with this request.');
        }
        if (preg_match('/^[A-Za-z0-9_-]{8,64}$/', $key) !== 1) {
            throw new ApiException(400, 'idempotency_key_required', 'The Idempotency-Key must be 8–64 letters, digits, dashes or underscores (a UUID or ULID).');
        }
        $storeId = $this->storeId($request);
        $hash = $this->hash($request);

        $row = $this->claim($storeId, $scope, $key, $hash);
        if ($row instanceof JsonResponse) {
            return $row;
        }

        try {
            $response = $next($request);
        } catch (\Throwable $e) {
            $this->release($row);

            throw $e;
        }

        if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300) {
            $row->status = IdempotencyKey::COMPLETED;
            $row->response_status = $response->getStatusCode();
            $row->response_body = (string) $response->getContent();
            $row->save();
        } else {
            $this->release($row);
        }

        return $response;
    }

    /** sha256 of the canonical body (+ the cart / order token hash, + the route path). */
    private function hash(Request $request): string
    {
        $body = $request->json()->all();
        self::ksortRecursive($body);
        $cart = (string) $request->header('X-Cart-Token', '');
        // 5b-2: /storefront/orders/pay is per order (X-Order-Token): one key can't replay another order's answer.
        $orderToken = (string) $request->header('X-Order-Token', '');

        return hash('sha256', $request->method().' '.$request->path()."\n".json_encode($body)."\n".($cart !== '' ? hash('sha256', $cart) : '')
            .($orderToken !== '' ? "\n".hash('sha256', $orderToken) : ''));
    }

    private function claim(string $storeId, string $scope, string $key, string $hash): IdempotencyKey|JsonResponse
    {
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $row = new IdempotencyKey;
            $row->store_id = $storeId;
            $row->scope = $scope;
            $row->key = $key;
            $row->request_hash = $hash;
            $row->status = IdempotencyKey::PROCESSING;
            $row->locked_until = now()->addSeconds(self::LOCK_SECONDS);
            $row->created_at = now();
            $row->expires_at = now()->addHours(self::TTL_HOURS);
            try {
                DB::transaction(fn () => $row->save());

                return $row;
            } catch (QueryException $e) {
                if (! str_contains(strtolower($e->getMessage()), 'unique') && ! str_contains($e->getMessage(), '23505')) {
                    throw $e;
                }
            }

            /** @var IdempotencyKey|null $existing */
            $existing = IdempotencyKey::query()->where('store_id', $storeId)->where('scope', $scope)->where('key', $key)->first();
            if ($existing === null) {
                continue; // deleted in between (failed attempt): try again
            }
            if ($existing->expires_at->isPast()) {
                IdempotencyKey::query()->whereKey($existing->id)->where('expires_at', '<=', now())->delete();

                continue;
            }
            if ($existing->request_hash !== $hash) {
                throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
            }
            if ($existing->status === IdempotencyKey::COMPLETED) {
                return new JsonResponse(
                    json_decode((string) $existing->response_body, true),
                    (int) $existing->response_status,
                    ['Idempotent-Replayed' => 'true', 'Cache-Control' => 'private, no-store'],
                );
            }
            if ($existing->locked_until->isFuture()) {
                throw new ApiException(409, 'idempotency_key_in_use', 'This request is still being processed. Try again in a moment.');
            }
            // Stale `processing` row (crashed worker): take it over atomically.
            $taken = IdempotencyKey::query()->whereKey($existing->id)->where('status', IdempotencyKey::PROCESSING)
                ->where('locked_until', $existing->locked_until)->update(['locked_until' => now()->addSeconds(self::LOCK_SECONDS)]);
            if ($taken === 1) {
                return $existing->refresh();
            }
        }

        throw new ApiException(409, 'idempotency_key_in_use', 'This request is still being processed. Try again in a moment.');
    }

    private function release(IdempotencyKey $row): void
    {
        IdempotencyKey::query()->whereKey($row->id)->where('status', IdempotencyKey::PROCESSING)->delete();
    }

    private function storeId(Request $request): string
    {
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);
        if ($resolved instanceof ResolvedStorefront) {
            return $resolved->storeId;
        }
        $store = $request->route('store');
        if ($store instanceof Store) {
            return $store->id;
        }

        return Store::query()->whereKey(strtolower((string) $store))->value('id')
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** @param array<mixed> $value */
    private static function ksortRecursive(array &$value): void
    {
        if (! array_is_list($value)) {
            ksort($value);
        }
        foreach ($value as &$v) {
            if (is_array($v)) {
                self::ksortRecursive($v);
            }
        }
    }
}
