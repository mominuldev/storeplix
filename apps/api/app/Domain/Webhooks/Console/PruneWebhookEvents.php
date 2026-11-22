<?php

declare(strict_types=1);

namespace App\Domain\Webhooks\Console;

use App\Domain\Payments\Models\WebhookEvent;
use Illuminate\Console\Command;

/** `webhooks:prune` (daily): webhook_events older than 90 days (PHASE-5B §3 000600 retention). */
class PruneWebhookEvents extends Command
{
    public const RETENTION_DAYS = 90;

    protected $signature = 'webhooks:prune';

    protected $description = 'Delete webhook events older than 90 days';

    public function handle(): int
    {
        // cross-tenant: platform retention job (platform connection); deletes only rows past the retention window.
        $count = WebhookEvent::withoutTenancy()->where('received_at', '<', now()->subDays(self::RETENTION_DAYS))->delete();
        $this->info("Deleted {$count} webhook events.");

        return self::SUCCESS;
    }
}
