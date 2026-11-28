<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Console;

use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/**
 * `tracking:prune` (daily, PHASE-8-9D P89D-18): tracking_events delivered / skipped after 7 days and failed after 30
 * (payloads of final rows are already null); tracking_daily_stats after 90 days; order_tracking_contexts IP / UA nulled
 * after 90 days and rows deleted after 180 days; catalog_sync_runs after 90 days. Platform connection, ids only.
 */
class PruneTracking extends Command
{
    protected $signature = 'tracking:prune';

    protected $description = 'Prune the tracking event log, daily stats, checkout contexts and feed sync runs';

    public function handle(): int
    {
        // cross-tenant: retention sweep (platform connection) over rows identified by age only.
        $db = PlatformDb::connection();
        $r = (array) config('tracking.retention');
        $events = $db->table('tracking_events')->whereIn('status', ['delivered', 'skipped'])->where('created_at', '<', now()->subDays((int) ($r['delivered'] ?? 7)))->delete()
            + $db->table('tracking_events')->where('status', 'failed')->where('created_at', '<', now()->subDays((int) ($r['failed'] ?? 30)))->delete();
        $nulled = $db->table('tracking_events')->whereIn('status', ['delivered', 'failed', 'skipped'])->whereNotNull('payload')->update(['payload' => null]);
        $stats = $db->table('tracking_daily_stats')->where('date', '<', now()->subDays((int) ($r['stats'] ?? 90))->toDateString())->delete();
        $ips = $db->table('order_tracking_contexts')->where('created_at', '<', now()->subDays((int) ($r['context_ip'] ?? 90)))
            ->where(fn ($q) => $q->whereNotNull('client_ip')->orWhereNotNull('user_agent'))->update(['client_ip' => null, 'user_agent' => null]);
        $contexts = $db->table('order_tracking_contexts')->where('created_at', '<', now()->subDays((int) ($r['context'] ?? 180)))->delete();
        $runs = $db->table('catalog_sync_runs')->where('started_at', '<', now()->subDays((int) config('feeds.runs_retention_days', 90)))->delete();
        $this->info("tracking:prune: {$events} event(s), {$nulled} payload(s) nulled, {$stats} stat row(s), {$ips} context IP(s) nulled, {$contexts} context(s), {$runs} sync run(s).");

        return self::SUCCESS;
    }
}
