<?php

declare(strict_types=1);

namespace App\Domain\Automations\Jobs;

use App\Domain\Automations\Engine\Conversions;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** P86-14/P86-15: recovery exit + attribution for a placed order. Idempotent, so it may retry. */
class HandleOrderPlaced implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    public int $timeout = 60;

    /** @var list<int> */
    public array $backoff = [10, 60];

    public function __construct(public readonly string $orderId)
    {
        $this->onQueue((string) config('automations.queue', 'automations'));
    }

    public function handle(Conversions $conversions): void
    {
        $conversions->orderPlaced($this->orderId);
    }
}
