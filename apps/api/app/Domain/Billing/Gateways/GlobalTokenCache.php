<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Tenancy\Support\TenantCache;

/**
 * P7-10: the platform bKash grant token lives in the GLOBAL cache (`billing:bkash:token:{fingerprint}…`), not per tenant,
 * so the 2-calls/hour grant limit is shared correctly by every tenant paying Storeplix. Keys are used as given.
 */
final class GlobalTokenCache extends TenantCache
{
    public function key(string $key): string
    {
        return $key;
    }
}
