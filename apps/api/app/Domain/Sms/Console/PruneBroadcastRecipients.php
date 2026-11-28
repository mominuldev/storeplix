<?php

declare(strict_types=1);

namespace App\Domain\Sms\Console;

use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/** PHASE-8-9B §3.1: broadcast recipient rows are deleted 13 months after they were created (as P85-28). */
class PruneBroadcastRecipients extends Command
{
    protected $signature = 'sms:prune-broadcast-recipients';

    protected $description = 'Delete platform SMS broadcast recipients older than 13 months (PHASE-8-9B §3.1)';

    public function handle(): int
    {
        $before = now()->subMonths((int) config('sms.platform.recipient_retention_months', 13));
        $total = 0;
        do {
            $ids = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('created_at', '<', $before)->limit(1000)->pluck('id')->all();
            if ($ids !== []) {
                $total += PlatformDb::connection()->table('platform_sms_broadcast_recipients')->whereIn('id', $ids)->delete();
            }
        } while (count($ids) === 1000);
        $this->info("Pruned {$total} broadcast recipients.");

        return self::SUCCESS;
    }
}
