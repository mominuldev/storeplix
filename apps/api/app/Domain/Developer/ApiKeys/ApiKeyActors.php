<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys;

use App\Domain\Developer\ApiKeys\Models\ApiKey;

/**
 * PHASE-8-4 §3 / openapi 1.12.0: how an API key appears as the actor of an order event or a stock movement:
 * `{type: 'api_key', id: <key id>, name: 'API: <key name>'}` (current name; keys are never deleted).
 */
final class ApiKeyActors
{
    /** @return array{type: string, id: string, name: string|null} */
    public static function ref(string $keyId): array
    {
        $name = ApiKey::query()->whereKey($keyId)->value('name');

        return ['type' => 'api_key', 'id' => $keyId, 'name' => $name === null ? null : 'API: '.$name];
    }
}
