<?php

namespace App\Domain\Stores\Services;

use App\Domain\Shared\Http\ApiException;

/** D1: a tenant owns exactly one store. Rendered as 409 store_limit_reached. */
class StoreLimitReachedException extends ApiException
{
    public function __construct()
    {
        parent::__construct(409, 'store_limit_reached', 'This account already has a store. Only one store per merchant is allowed.');
    }
}
