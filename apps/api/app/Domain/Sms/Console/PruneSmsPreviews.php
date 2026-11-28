<?php

declare(strict_types=1);

namespace App\Domain\Sms\Console;

use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/**
 * PHASE-8-9A P89A-21 (S217): SMS log previews are nulled 90 days after the SMS (daily). Platform-wide on the admin
 * connection (`sms_messages` is a platform table); only the preview column is touched.
 */
class PruneSmsPreviews extends Command
{
    protected $signature = 'sms:prune-previews';

    protected $description = 'Null SMS log previews older than the retention period (PHASE-8-9A P89A-21)';

    public function handle(): int
    {
        $before = now()->subDays((int) config('sms.preview_days', 90));
        $total = 0;
        do {
            $ids = PlatformDb::connection()->table('sms_messages')->whereNotNull('body_preview')->where('created_at', '<', $before)
                ->limit(1000)->pluck('id')->all();
            if ($ids !== []) {
                $total += PlatformDb::connection()->table('sms_messages')->whereIn('id', $ids)->update(['body_preview' => null]);
            }
        } while (count($ids) === 1000);
        $this->info("Pruned {$total} SMS previews.");

        return self::SUCCESS;
    }
}
