<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Jobs;

use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-8 §5.1/§5.2: one explained risk check for one order, queued after the placement commits (P88-6). Idempotent
 * (the order row lock + "a check exists → stop"): duplicate jobs and retries write one check, one event, one link
 * (S157). Own-shop data only; no HTTP call.
 */
class CheckOrderRisk implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    public int $timeout = 60;

    /** @var list<int> */
    public array $backoff = [10, 60];

    public function __construct(public readonly string $orderId)
    {
        $this->onQueue('default');
    }

    public function handle(FraudGuard $guard): void
    {
        $guard->check($this->orderId);
    }
}
