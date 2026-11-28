<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Console;

use App\Domain\Tracking\Jobs\DeliverTrackingEvent;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Console\Command;

/**
 * `tracking:dispatch-due` (every minute, PHASE-8-9D P89D-15): the retry sweep. Discovery on the platform connection,
 * then one tenant-aware DeliverTrackingEvent per due row; the job claims the row with a lease, so an overlap is a no-op.
 */
class DispatchDueTrackingEvents extends Command
{
    protected $signature = 'tracking:dispatch-due {--sync : run the deliveries inline}';

    protected $description = 'Dispatch tracking events whose next delivery attempt is due';

    public function handle(): int
    {
        // cross-tenant: scheduler discovery (platform connection); each event is delivered in its own tenant job.
        $rows = TrackingEvent::withoutTenancy()
            ->whereIn('status', TrackingEvent::OPEN)
            ->whereNotNull('next_attempt_at')
            ->where('next_attempt_at', '<=', now())
            ->orderBy('next_attempt_at')
            ->limit((int) config('tracking.dispatch_batch', 500))
            ->get(['id', 'tenant_id']);
        foreach ($rows as $row) {
            $job = (new DeliverTrackingEvent((string) $row->id))->forTenant((string) $row->tenant_id);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('tracking:dispatch-due: %d event(s).', $rows->count()));

        return self::SUCCESS;
    }
}
