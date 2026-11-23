<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles;

use App\Domain\Tenancy\Events\TenantCreated;

/** PHASE-8-3 §5.2: every new tenant gets its system roles in the creating transaction (TenantCreated is sync). */
class EnsureSystemRoles
{
    public function handle(TenantCreated $event): void
    {
        SystemRoles::ensure($event->tenant);
    }
}
