<?php

declare(strict_types=1);

namespace App\Domain\Admin\Authorization;

/** PHASE-8-1 P8-2: fixed platform roles (`users.platform_role`). */
enum PlatformRole: string
{
    case SuperAdmin = 'super_admin';
    case Billing = 'billing';
    case Support = 'support';
    case ReadOnly = 'read_only';

    /** @return list<PlatformPermission> PHASE-8-1 §2.1 matrix (single source; `AdminPermissionTest` covers every cell). */
    public function permissions(): array
    {
        return match ($this) {
            self::SuperAdmin => PlatformPermission::cases(),
            self::Billing => [PlatformPermission::ViewMerchants, PlatformPermission::ManageBilling],
            self::Support => [PlatformPermission::ViewMerchants, PlatformPermission::Impersonate, PlatformPermission::ManageDomains],
            self::ReadOnly => [PlatformPermission::ViewMerchants],
        };
    }

    public function can(PlatformPermission $permission): bool
    {
        return in_array($permission, $this->permissions(), true);
    }
}
