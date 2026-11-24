<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys\Http\Controllers;

use App\Domain\Developer\ApiKeys\ApiKeyService;
use App\Domain\Developer\ApiKeys\Http\Requests\CreateApiKeyRequest;
use App\Domain\Developer\ApiKeys\Http\Requests\RenameApiKeyRequest;
use App\Domain\Developer\ApiKeys\Http\Resources\ApiKeyResource;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-4 §6.1: GET|POST /api-keys, PATCH|DELETE /api-keys/{key}, GET /api-scopes. Every route is
 * `perm:developers.manage`; {key} binds inside the current tenant (foreign id → 404). Writes need `api_webhooks` (402).
 */
class ApiKeyController
{
    public function __construct(
        private readonly ApiKeyService $keys,
        private readonly TenantContext $context,
    ) {}

    /** Active keys first (newest first), then keys revoked in the last 90 days (latest revocation first). */
    public function index(): JsonResponse
    {
        $keys = ApiKey::query()->with('creator')
            ->where(fn ($q) => $q->whereNull('revoked_at')->orWhere('revoked_at', '>=', now()->subDays(ApiKey::REVOKED_LISTED_DAYS)))
            ->get()
            ->sort(fn (ApiKey $a, ApiKey $b) => self::compare($a, $b))
            ->values();

        return new JsonResponse(['data' => $keys->map(fn (ApiKey $k) => ApiKeyResource::make($k))->all()]);
    }

    /** Active first; then newest first (created_at for active, revoked_at for revoked); ULID descending breaks ties. */
    private static function compare(ApiKey $a, ApiKey $b): int
    {
        $at = fn (ApiKey $k) => ($k->isRevoked() ? $k->revoked_at : $k->created_at)->getTimestamp();

        return [(int) $a->isRevoked(), $at($b), $b->id] <=> [(int) $b->isRevoked(), $at($a), $a->id];
    }

    public function store(CreateApiKeyRequest $request): JsonResponse
    {
        $this->keys->assertFeature();
        [$key, $plain] = $this->keys->create($request->validated(), $request->user());

        return new JsonResponse(['data' => ApiKeyResource::created($key->load('creator'), $plain)], 201, ['Cache-Control' => 'no-store']);
    }

    public function update(RenameApiKeyRequest $request, ApiKey $key): JsonResponse
    {
        $this->keys->assertFeature();
        $key = $this->keys->rename($key, $request->validated('name'));

        return new JsonResponse(['data' => ApiKeyResource::make($key->load('creator'))]);
    }

    public function destroy(Request $request, ApiKey $key): JsonResponse
    {
        $this->keys->assertFeature();
        $key = $this->keys->revoke($key, $request->user());

        return new JsonResponse(['data' => ApiKeyResource::make($key->load('creator'))]);
    }

    public function scopes(): JsonResponse
    {
        return new JsonResponse(['data' => ApiKeyResource::catalogue($this->context->permissions())]);
    }
}
