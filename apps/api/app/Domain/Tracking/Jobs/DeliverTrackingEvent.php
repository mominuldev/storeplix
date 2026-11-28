<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Jobs;

use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tracking\TrackingDelivery;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * One delivery attempt of one tracking event (PHASE-8-9D P89D-15), inside the event's tenant, on queue `tracking`.
 * Carries the row id only — never a payload or secret (S332). Unique per row; the queue never retries (the schedule
 * lives on the row and `tracking:dispatch-due` re-dispatches due rows).
 */
class DeliverTrackingEvent implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 30;

    public int $uniqueFor = 120;

    public function __construct(public readonly string $eventId)
    {
        $this->onQueue((string) config('tracking.queue', 'tracking'));
    }

    public function uniqueId(): string
    {
        return 'tracking-event:'.$this->eventId;
    }

    public function handle(TrackingDelivery $delivery): void
    {
        $delivery->attempt($this->eventId);
    }
}
