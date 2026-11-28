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

    /** @return list<PlatformPermission> PHASE-8-1 §2.1 matrix, amended by PHASE-8-2 §2.1 (`view_analytics`: SA, BI, RO) amendment A1-4 (`manage_settings`: SA only) and PHASE-8-9C §2.2 (`manage_help_content`: SA, SU; `manage_support`: SA, SU, BI) (single source; `AdminPermissionTest` covers every cell). */
    public function permissions(): array
    {
        return match ($this) {
            self::SuperAdmin => PlatformPermission::cases(),
            self::Billing => [PlatformPermission::ViewMerchants, PlatformPermission::ManageBilling, PlatformPermission::ViewAnalytics, PlatformPermission::ManageSupport],
            self::Support => [PlatformPermission::ViewMerchants, PlatformPermission::Impersonate, PlatformPermission::ManageDomains,
                PlatformPermission::ManageHelpContent, PlatformPermission::ManageSupport],
            self::ReadOnly => [PlatformPermission::ViewMerchants, PlatformPermission::ViewAnalytics],
        };
    }

    public function can(PlatformPermission $permission): bool
    {
        return in_array($permission, $this->permissions(), true);
    }
}
