<?php

declare(strict_types=1);

namespace App\Domain\Automations\Jobs;

use App\Domain\Automations\Engine\AutomationEngine;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-6 §4.3: one trigger occurrence × one automation. `tries = 1` (a message step is never repeated by the queue;
 * a retried or duplicated job produces no second run, P86-4). $timeout < REDIS_QUEUE_RETRY_AFTER (360) with margin.
 */
class EvaluateAutomation implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 240;

    public function __construct(
        public readonly string $automationId,
        public readonly string $trigger,
        public readonly string $subjectType,
        public readonly string $subjectId,
    ) {
        $this->onQueue((string) config('automations.queue', 'automations'));
    }

    public function handle(AutomationEngine $engine): void
    {
        $engine->start($this->automationId, $this->trigger, $this->subjectType, $this->subjectId);
    }
}
