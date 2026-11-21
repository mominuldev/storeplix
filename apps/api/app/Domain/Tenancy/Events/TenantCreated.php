<?php

namespace App\Domain\Tenancy\Events;

use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Events\Dispatchable;

/** Fired synchronously inside the transaction that creates the tenant. */
class TenantCreated
{
    use Dispatchable;

    public function __construct(public readonly Tenant $tenant) {}
}
