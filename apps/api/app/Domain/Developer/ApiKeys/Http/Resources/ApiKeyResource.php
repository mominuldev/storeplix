<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys\Http\Resources;

use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\PermissionSet;

/**
 * PHASE-8-4 §6.2 shapes: `ApiKey` (create adds `plain_key`, only there), `ApiScopeInfo` and the external
 * `ApiKeyIdentity` (§3 GET /external/me). `key_hash` is never part of any shape (S100).
 */
final class ApiKeyResource
{
    /** @return array<string, mixed> ApiKey */
    public static function make(ApiKey $key): array
    {
        return [
            'id' => $key->id,
            'name' => $key->name,
            'prefix' => $key->prefix,
            'last_four' => $key->last_four,
            'masked' => $key->masked(),
            'scopes' => array_map(fn (ApiScope $s) => $s->value, $key->grantedScopes()),
            'include_costs' => (bool) $key->include_costs,
            'status' => $key->isRevoked() ? 'revoked' : 'active',
            'created_at' => UserRef::iso($key->created_at),
            'created_by' => UserRef::of($key->creator),
            'last_used_at' => UserRef::iso($key->last_used_at),
            'revoked_at' => UserRef::iso($key->revoked_at),
        ];
    }

    /** @return array<string, mixed> ApiKeyCreated */
    public static function created(ApiKey $key, string $plain): array
    {
        return self::make($key) + ['plain_key' => $plain];
    }

    /** @return list<array<string, mixed>> ApiScopeInfo[] with `grantable` for the actor */
    public static function catalogue(PermissionSet $held): array
    {
        return array_map(fn (ApiScope $s) => [
            'key' => $s->value,
            'label' => $s->label(),
            'group' => $s->group(),
            'backing_permission' => $s->backingPermission()?->value,
            'implies' => array_map(fn (ApiScope $i) => $i->value, $s->implies()),
            'grantable' => $s->grantableBy($held),
        ], ApiScope::cases());
    }

    /** @return array<string, mixed> ApiKeyIdentity */
    public static function identity(ApiKey $key, ?Store $store): array
    {
        return [
            'id' => $key->id,
            'name' => $key->name,
            'scopes' => array_map(fn (ApiScope $s) => $s->value, $key->grantedScopes()),
            'tenant_id' => $key->tenant_id,
            'store' => $store === null ? null : [
                'id' => $store->id,
                'name' => $store->name,
                'currency' => $store->currency ?: 'BDT',
            ],
        ];
    }
}
