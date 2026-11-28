<?php

declare(strict_types=1);

namespace App\Domain\Admin\Authorization;

/**
 * PHASE-8-1 §2.1 (+ PHASE-8-2 §2.1 `view_analytics`, + amendment A1-4 `manage_settings`, + PHASE-8-9C §2.2
 * `manage_help_content`, `manage_support`). Route middleware:
 * `platform.can:<value>`.
 */
enum PlatformPermission: string
{
    case ViewMerchants = 'view_merchants';
    case Impersonate = 'impersonate';
    case ManageBilling = 'manage_billing';
    case ManageDomains = 'manage_domains';
    case Suspend = 'suspend';
    case ManageTeam = 'manage_team';
    case ViewAnalytics = 'view_analytics';
    case ManageSettings = 'manage_settings'; // amendment A1-4: super_admin only
    case ManageHelpContent = 'manage_help_content'; // PHASE-8-9C P89C-12: super_admin, support
    case ManageSupport = 'manage_support'; // PHASE-8-9C P89C-12: super_admin, support, billing
}
