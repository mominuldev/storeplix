<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Jobs;

use App\Domain\Marketing\Attribution;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** PHASE-8-5 §5.5: attributes one placed order to the latest campaign send (P85-21). Never blocks checkout. */
class AttributeOrder implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [10, 60];

    public function __construct(public readonly string $orderId)
    {
        $this->onQueue((string) config('campaigns.queue', 'campaigns'));
    }

    public function handle(Attribution $attribution): void
    {
        $attribution->attribute($this->orderId);
    }
}
