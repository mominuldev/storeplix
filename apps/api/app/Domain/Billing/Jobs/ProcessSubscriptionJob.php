<?php

declare(strict_types=1);

namespace App\Domain\Billing\Jobs;

use App\Domain\Billing\SubscriptionProcessor;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** §4.1: one tenant's due billing work (queue `billing`, unique 10 min, 3 tries, 120 s). */
class ProcessSubscriptionJob implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    public int $timeout = 120;

    public int $uniqueFor = 600;

    public function __construct(string $tenantId)
    {
        $this->forTenant($tenantId);
        $this->onQueue('billing');
    }

    public function uniqueId(): string
    {
        return (string) $this->tenantId;
    }

    public function handle(SubscriptionProcessor $processor): void
    {
        $processor->process();
    }
}
