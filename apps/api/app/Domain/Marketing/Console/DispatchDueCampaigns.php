<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Console;

use App\Domain\Marketing\CampaignPipeline;
use App\Domain\Marketing\Jobs\StartCampaign;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\QuietHours;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `campaigns:dispatch-due` (every minute, PHASE-8-5 P85-16). Discovery on the platform connection (cross-tenant:
 * scheduler discovery), then per tenant:
 *  - `scheduled → sending` by conditional UPDATE (`WHERE status='scheduled' AND scheduled_at <= now()`), at most 3
 *    sending per store (P85-27), never inside quiet hours (P85-15); then a StartCampaign job;
 *  - resume: a `sending` campaign with `queued` recipients and no recipient activity for `resume_after_minutes`
 *    (paused by quiet hours, or a lost batch) gets its batches dispatched again — outside quiet hours only.
 * Running it twice is harmless: the UPDATE moves a campaign once, and recipient claims are conditional (S121).
 */
class DispatchDueCampaigns extends Command
{
    protected $signature = 'campaigns:dispatch-due {--sync : run the jobs inline}';

    protected $description = 'Start due scheduled campaigns and resume paused ones';

    public function handle(TenantContext $context): int
    {
        // cross-tenant: scheduler discovery (platform connection); the work runs inside each tenant.
        $due = Campaign::withoutTenancy()->where('status', Campaign::SCHEDULED)->where('scheduled_at', '<=', now())
            ->orderBy('scheduled_at')->limit(500)->get(['id', 'tenant_id', 'store_id']);
        // cross-tenant: scheduler discovery of campaigns still sending.
        $sending = Campaign::withoutTenancy()->where('status', Campaign::SENDING)->limit(500)->get(['id', 'tenant_id', 'store_id']);

        $started = 0;
        $resumed = 0;
        foreach ($due as $row) {
            $started += (int) $context->run((string) $row->tenant_id, fn () => $this->startDue((string) $row->id));
        }
        foreach ($sending as $row) {
            $resumed += (int) $context->run((string) $row->tenant_id, fn () => $this->resume((string) $row->id));
        }
        $this->info("campaigns:dispatch-due: {$started} started, {$resumed} resumed.");

        return self::SUCCESS;
    }

    private function startDue(string $id): bool
    {
        $campaign = Campaign::query()->find($id);
        $store = $campaign !== null ? Store::query()->find($campaign->store_id) : null;
        if ($campaign === null || $store === null || QuietHours::isQuiet(now(), (string) ($store->timezone ?: 'Asia/Dhaka'))) {
            return false;
        }
        $sending = Campaign::query()->where('store_id', $store->id)->where('status', Campaign::SENDING)->count();
        if ($sending >= (int) config('campaigns.max_sending_per_store', 3)) {
            return false;
        }
        $moved = Campaign::query()->whereKey($id)->where('status', Campaign::SCHEDULED)->where('scheduled_at', '<=', now())
            ->update(['status' => Campaign::SENDING, 'started_at' => now(), 'updated_at' => now()]);
        if ($moved !== 1) {
            return false;
        }
        $this->runJob(new StartCampaign($id));

        return true;
    }

    private function resume(string $id): bool
    {
        $campaign = Campaign::query()->find($id);
        $store = $campaign !== null ? Store::query()->find($campaign->store_id) : null;
        if ($campaign === null || $store === null || QuietHours::isQuiet(now(), (string) ($store->timezone ?: 'Asia/Dhaka'))) {
            return false;
        }
        $recipients = CampaignRecipient::query()->where('campaign_id', $id);
        if (! (clone $recipients)->exists()) {
            // Never materialized (a lost StartCampaign): start again (unique job, idempotent snapshot).
            if ($campaign->started_at === null || $campaign->started_at->lt(now()->subMinutes((int) config('campaigns.resume_after_minutes', 2)))) {
                $this->runJob(new StartCampaign($id));

                return true;
            }

            return false;
        }
        if (! (clone $recipients)->where('status', CampaignRecipient::QUEUED)->exists()) {
            app(CampaignPipeline::class)->finish($id);

            return false;
        }
        $last = (clone $recipients)->max('updated_at');
        if ($last !== null && now()->diffInMinutes($last, true) < (int) config('campaigns.resume_after_minutes', 2)) {
            return false;
        }

        return app(CampaignPipeline::class)->dispatchQueued($id) > 0;
    }

    private function runJob(object $job): void
    {
        $this->option('sync') ? dispatch_sync($job) : dispatch($job);
    }
}
