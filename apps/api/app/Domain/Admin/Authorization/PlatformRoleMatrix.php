<?php

declare(strict_types=1);

namespace App\Domain\Admin\Authorization;

/** openapi `PlatformRoleMatrix` (read-only in 8.1, PHASE-8-1 P8-2 / Q96), built from `PlatformRole::permissions()`. */
final class PlatformRoleMatrix
{
    /** @return array{roles: list<string>, permissions: list<string>, grants: array<string, list<string>>} */
    public static function toArray(): array
    {
        $grants = [];
        foreach (PlatformRole::cases() as $role) {
            $grants[$role->value] = array_map(fn (PlatformPermission $p) => $p->value, $role->permissions());
        }

        return [
            'roles' => array_map(fn (PlatformRole $r) => $r->value, PlatformRole::cases()),
            'permissions' => array_map(fn (PlatformPermission $p) => $p->value, PlatformPermission::cases()),
            'grants' => $grants,
        ];
    }
}
