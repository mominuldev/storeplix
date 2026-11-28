<?php

declare(strict_types=1);

namespace App\Domain\Ai\Jobs;

use App\Domain\Ai\AiRunner;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

/**
 * PHASE-8-9D §11 (queue `ai`, TenantAware, tries 1): runs one generation by id. The payload carries the id only —
 * never input text, keys or images. A replay is a no-op (AiRunner claims queued → running once).
 */
class EditProductPhoto implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 180;

    public function __construct(public readonly string $generationId) {}

    public function handle(AiRunner $runner): void
    {
        $runner->editPhoto($this->generationId);
    }

    /** The worker gave up (timeout, crash): the generation fails and its credits come back (P89D-56). */
    public function failed(?Throwable $e = null): void
    {
        if ($this->tenantId !== null) {
            app(TenantContext::class)->run($this->tenantId, fn () => app(AiRunner::class)->abandon($this->generationId));
        }
    }
}
