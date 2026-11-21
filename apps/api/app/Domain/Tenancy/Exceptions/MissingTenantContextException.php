<?php

namespace App\Domain\Tenancy\Exceptions;

use LogicException;

/**
 * Thrown when tenant-owned data is touched without a tenant context.
 * This is a programming error: either resolve a tenant first or opt out explicitly
 * with Model::withoutTenancy() in platform/system code.
 */
class MissingTenantContextException extends LogicException
{
    public function __construct(string $message = 'No tenant context is set for a tenant-scoped operation.')
    {
        parent::__construct($message);
    }
}
