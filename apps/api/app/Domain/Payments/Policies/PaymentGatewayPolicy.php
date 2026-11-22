<?php

declare(strict_types=1);

namespace App\Domain\Payments\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;

/**
 * Integrations (PHASE-5B §4.1, §4.6; S38): reads O A S, writes (connect, enable, test payment, disconnect) O A
 * (`ManageIntegrations`). Registered as the `integrations.view` / `integrations.manage` abilities on a Store.
 */
final class PaymentGatewayPolicy
{
    use Authorizes;

    public function view(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store) && $this->can(Permission::Operate);
    }

    public function manage(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store) && $this->can(Permission::ManageIntegrations);
    }
}
