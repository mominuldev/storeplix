<?php

declare(strict_types=1);

namespace App\Domain\Developer\Console;

use App\Domain\Developer\Webhooks\Jobs\DeliverWebhook;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use Illuminate\Console\Command;

/**
 * `webhooks:dispatch-due` (every minute, PHASE-8-4 §4.4): the retry sweep. Discovery on the platform connection
 * (cross-tenant: scheduler discovery), then one tenant-aware DeliverWebhook per due delivery; the job claims the row
 * under a lock, so an overlapping dispatch is a no-op. Lives under Domain/Developer/Console (RLS bypass allowlist).
 */
class DispatchDueWebhooks extends Command
{
    protected $signature = 'webhooks:dispatch-due {--sync : run the deliveries inline}';

    protected $description = 'Dispatch outbound webhook deliveries whose next attempt is due';

    public function handle(): int
    {
        // cross-tenant: scheduler discovery (platform connection); each delivery runs in its own tenant job.
        $rows = WebhookDelivery::withoutTenancy()
            ->whereIn('status', WebhookDelivery::OPEN)
            ->whereNotNull('next_attempt_at')
            ->where('next_attempt_at', '<=', now())
            ->orderBy('next_attempt_at')
            ->limit((int) config('webhooks_out.dispatch_batch', 500))
            ->get(['id', 'tenant_id']);
        foreach ($rows as $row) {
            $job = (new DeliverWebhook((string) $row->id))->forTenant((string) $row->tenant_id);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('webhooks:dispatch-due: %d delivery(ies).', $rows->count()));

        return self::SUCCESS;
    }
}
