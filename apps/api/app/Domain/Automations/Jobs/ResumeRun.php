<?php

declare(strict_types=1);

namespace App\Domain\Automations\Jobs;

use App\Domain\Automations\Engine\AutomationEngine;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** Continues a run that `automations:resume-due` moved `waiting → running` (P86-23). `tries = 1`, ≤ 240 s. */
class ResumeRun implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 240;

    public function __construct(public readonly string $runId)
    {
        $this->onQueue((string) config('automations.queue', 'automations'));
    }

    public function handle(AutomationEngine $engine): void
    {
        $engine->resume($this->runId);
    }
}
