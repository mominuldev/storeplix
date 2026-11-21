<?php

namespace App\Domain\Tenancy\Exceptions;

use LogicException;

/** Thrown when a tenant-owned model is written with a tenant_id different from the current context. */
class TenantMismatchException extends LogicException {}
