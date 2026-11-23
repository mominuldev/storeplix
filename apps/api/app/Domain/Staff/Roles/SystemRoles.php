<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles;

use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-3 §5.2: every tenant has the three system roles (owner / admin "Manager" / staff) as `roles` rows.
 * `ensure()` is idempotent and race-safe (INSERT … ON CONFLICT DO NOTHING on U(tenant_id, key)); it runs on every
 * tenant creation (TenantCreated listener: registration, factories, seeders) and in the 000300 backfill.
 */
final class SystemRoles
{
    /**
     * Creates the missing system roles of the tenant and returns their ids keyed by system key.
     *
     * Without $db it runs on the app connection inside the tenant's context (RLS: roles are written only within
     * the current tenant). The backfill migration passes the migrating (owner) connection instead.
     *
     * @return array<string, string> key => roles.id
     */
    public static function ensure(Tenant|string $tenant, ?ConnectionInterface $db = null): array
    {
        $tenantId = $tenant instanceof Tenant ? (string) $tenant->getKey() : $tenant;

        if ($db !== null) {
            return self::write($db, $tenantId);
        }

        $context = app(TenantContext::class);
        if ($context->id() === $tenantId) {
            return self::write(DB::connection(), $tenantId);
        }

        return $context->run($tenantId, fn () => self::write(DB::connection(), $tenantId));
    }

    /** roles.id of a system role of the CURRENT tenant (creating the system roles when missing). */
    public static function id(SystemRole $role): string
    {
        $context = app(TenantContext::class);
        $id = Role::query()->where('key', $role->value)->value('id');

        return $id ?? self::ensure($context->requireId())[$role->value];
    }

    /** @return array<string, string> */
    private static function write(ConnectionInterface $db, string $tenantId): array
    {
        $existing = self::existing($db, $tenantId);
        $missing = array_filter(SystemRole::cases(), fn (SystemRole $r) => ! isset($existing[$r->value]));

        if ($missing !== []) {
            $now = now();
            $db->table('roles')->insertOrIgnore(array_values(array_map(fn (SystemRole $r) => [
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $tenantId,
                'key' => $r->value,
                'name' => $r->label(),
                'description' => $r->description(),
                'is_system' => true,
                'revision' => 1,
                'created_at' => $now,
                'updated_at' => $now,
            ], $missing)));
            $existing = self::existing($db, $tenantId);
        }

        return $existing;
    }

    /** @return array<string, string> */
    private static function existing(ConnectionInterface $db, string $tenantId): array
    {
        return $db->table('roles')->where('tenant_id', $tenantId)->whereNotNull('key')->pluck('id', 'key')
            ->map(fn ($id) => (string) $id)->all();
    }
}
