<?php

namespace App\Domain\Staff;

use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;

/** seats_used = active non-owner members + pending (unexpired, unrevoked, unaccepted) invitations. */
class SeatCounter
{
    public function __construct(private readonly TenantContext $context) {}

    public function used(Tenant $tenant): int
    {
        $members = TenantUser::query()->forTenant($tenant->id)->where('role', '!=', TenantUser::ROLE_OWNER)->count();
        $pending = $this->context->run($tenant, fn () => StaffInvitation::query()->pending()->count());

        return $members + $pending;
    }
}
