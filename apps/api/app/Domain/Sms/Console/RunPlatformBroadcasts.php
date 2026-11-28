<?php

declare(strict_types=1);

namespace App\Domain\Sms\Console;

use App\Domain\Sms\Broadcasts\BroadcastService;
use App\Domain\Sms\Broadcasts\Jobs\SendPlatformBroadcastBatch;
use App\Domain\Sms\Broadcasts\Jobs\StartPlatformBroadcast;
use App\Domain\Sms\Broadcasts\SendingHours;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/**
 * PHASE-8-9B P89B-22 (every minute): starts due scheduled broadcasts (scheduled → sending, claimed with a conditional
 * update so two schedulers can't both start one) and resumes `sending` broadcasts paused at 21:00 once 09:00 Dhaka
 * comes round.
 */
class RunPlatformBroadcasts extends Command
{
    protected $signature = 'sms:run-broadcasts';

    protected $description = 'Start due platform SMS broadcasts and resume paused ones (PHASE-8-9B §7)';

    public function handle(): int
    {
        if (! SendingHours::open()) {
            return self::SUCCESS;
        }
        $due = BroadcastService::query()->where('status', PlatformSmsBroadcast::SCHEDULED)->where('scheduled_at', '<=', now())->pluck('id');
        foreach ($due as $id) {
            $claimed = BroadcastService::query()->whereKey($id)->where('status', PlatformSmsBroadcast::SCHEDULED)
                ->update(['status' => PlatformSmsBroadcast::SENDING, 'started_at' => now(), 'updated_at' => now()]);
            if ($claimed === 1) {
                StartPlatformBroadcast::dispatch((string) $id);
                $this->line("Started {$id}.");
            }
        }
        $sending = BroadcastService::query()->where('status', PlatformSmsBroadcast::SENDING)->whereNotIn('id', $due->all())->pluck('id');
        foreach ($sending as $id) {
            $pending = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('broadcast_id', $id)
                ->where('status', PlatformSmsBroadcastRecipient::PENDING)->whereNull('sms_message_id')->exists();
            $materialised = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('broadcast_id', $id)->exists();
            if (! $materialised) {
                StartPlatformBroadcast::dispatch((string) $id);
            } elseif ($pending) {
                SendPlatformBroadcastBatch::dispatch((string) $id);
            }
        }

        return self::SUCCESS;
    }
}
