<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts\Jobs;

use App\Domain\Sms\Broadcasts\BroadcastAudience;
use App\Domain\Sms\Broadcasts\BroadcastService;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;

/**
 * PHASE-8-9B P89B-22: materialises the recipients of a `sending` broadcast — one row per tenant in the audience, skipped
 * ones with their reason. The weekly cap (S228) is checked per tenant inside a tenant-keyed advisory lock (Postgres) so two
 * broadcasts racing can't both pass it; U(broadcast_id, tenant_id) makes a second run a no-op. Then the first batch.
 * Payload: the broadcast id only.
 */
class StartPlatformBroadcast implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public function __construct(public readonly string $broadcastId)
    {
        $this->onQueue('notifications');
    }

    public function handle(): void
    {
        $broadcast = BroadcastService::query()->whereKey($this->broadcastId)->first();
        if ($broadcast === null || $broadcast->status !== PlatformSmsBroadcast::SENDING) {
            return;
        }
        $db = PlatformDb::connection();
        $members = BroadcastAudience::members((array) $broadcast->audience);
        $cap = (int) config('sms.platform.weekly_cap', 2);
        $seen = [];
        foreach ($members as $t) {
            $db->transaction(function () use ($db, $broadcast, $t, &$seen) {
                if ($db->getDriverName() === 'pgsql') {
                    $db->select('select pg_advisory_xact_lock(hashtext(?))', ['platform-sms-cap:'.$t['tenant_id']]);
                }
                if ($db->table('platform_sms_broadcast_recipients')->where('broadcast_id', $broadcast->id)->where('tenant_id', $t['tenant_id'])->exists()) {
                    if ($t['user_id'] !== null) {
                        $seen[$t['user_id']] = true;
                    }

                    return; // a re-run
                }
                $counts = $db->table('platform_sms_broadcast_recipients')->where('tenant_id', $t['tenant_id'])
                    ->whereIn('status', [PlatformSmsBroadcastRecipient::SENT, PlatformSmsBroadcastRecipient::PENDING])
                    ->where('created_at', '>=', now()->subDays(7))->count();
                $reason = BroadcastAudience::skipReason($t, [$t['tenant_id'] => $counts], $seen);
                $now = now();
                try {
                    $db->table('platform_sms_broadcast_recipients')->insert([
                        'id' => Str::lower((string) Str::ulid()), 'broadcast_id' => $broadcast->id, 'tenant_id' => $t['tenant_id'],
                        'user_id' => $t['user_id'], 'to' => $reason === null ? $t['msisdn'] : null, 'language' => $t['language'],
                        'status' => $reason === null ? PlatformSmsBroadcastRecipient::PENDING : PlatformSmsBroadcastRecipient::SKIPPED,
                        'skip_reason' => $reason, 'created_at' => $now, 'updated_at' => $now,
                    ]);
                } catch (UniqueConstraintViolationException) {
                    // another worker materialised this tenant first
                }
            });
        }
        SendPlatformBroadcastBatch::refreshCounts($broadcast->id);
        SendPlatformBroadcastBatch::dispatch($broadcast->id);
    }
}
