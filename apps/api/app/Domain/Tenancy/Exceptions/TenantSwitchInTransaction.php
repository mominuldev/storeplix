<?php

namespace App\Domain\Tenancy\Exceptions;

use LogicException;

/**
 * TenantContext::set() with a different tenant while a database transaction is open (RLS on). A rollback would
 * silently restore the previous app.tenant_id while the context keeps the new tenant (PHASE-5B-CONTRACT P5B-3).
 * Switch tenants outside the transaction, or open the transaction inside TenantContext::run().
 */
class TenantSwitchInTransaction extends LogicException
{
    public function __construct(string $from, string $to)
    {
        parent::__construct(sprintf('Refusing to switch the tenant context from [%s] to [%s] inside an open transaction.', $from, $to));
    }
}
