<?php

declare(strict_types=1);

namespace App\Domain\Admin\Authorization;

/** PHASE-8-1 §2.1. Route middleware: `platform.can:<value>`. */
enum PlatformPermission: string
{
    case ViewMerchants = 'view_merchants';
    case Impersonate = 'impersonate';
    case ManageBilling = 'manage_billing';
    case ManageDomains = 'manage_domains';
    case Suspend = 'suspend';
    case ManageTeam = 'manage_team';
}
