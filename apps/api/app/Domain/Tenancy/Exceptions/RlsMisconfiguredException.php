<?php

namespace App\Domain\Tenancy\Exceptions;

use RuntimeException;

/** TENANCY_RLS=true with an app connection that would bypass row-level security (PHASE-5B-CONTRACT §2.2). */
class RlsMisconfiguredException extends RuntimeException {}
