<?php

declare(strict_types=1);

namespace App\Domain\Automations\Console;

use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `automations:reap-stuck` (every 5 min, P86-5): steps `sending` for more than 15 minutes become `unknown` — never
 * retried (the provider may have accepted the message). Runs left `running` without progress for that long (a lost
 * worker) go back to `waiting` due now; resume-due continues them and any step that already has a row is not repeated.
 */
class ReapStuckSteps extends Command
{
    protected $signature = 'automations:reap-stuck';

    protected $description = 'Mark stuck automation steps unknown and hand stalled runs back to resume-due';

    public function handle(TenantContext $context): int
    {
        $cutoff = now()->subMinutes((int) config('automations.stuck_after_minutes', 15));
        // cross-tenant: scheduler discovery (platform connection); updates run inside each tenant.
        $steps = AutomationRunStep::withoutTenancy()->where('status', AutomationRunStep::SENDING)->where('updated_at', '<', $cutoff)
            ->limit(5000)->get(['id', 'tenant_id']);
        // cross-tenant: scheduler discovery of stalled runs.
        $runs = AutomationRun::withoutTenancy()->where('status', AutomationRun::RUNNING)->where('updated_at', '<', $cutoff)
            ->limit(5000)->get(['id', 'tenant_id']);
        $unknown = 0;
        $requeued = 0;
        foreach ($steps->groupBy('tenant_id') as $tenantId => $group) {
            $unknown += (int) $context->run((string) $tenantId, fn () => AutomationRunStep::query()->whereIn('id', $group->pluck('id')->all())
                ->where('status', AutomationRunStep::SENDING)->where('updated_at', '<', $cutoff)
                ->update(['status' => AutomationRunStep::UNKNOWN, 'updated_at' => now()]));
        }
        foreach ($runs->groupBy('tenant_id') as $tenantId => $group) {
            $requeued += (int) $context->run((string) $tenantId, fn () => AutomationRun::query()->whereIn('id', $group->pluck('id')->all())
                ->where('status', AutomationRun::RUNNING)->where('updated_at', '<', $cutoff)
                ->update(['status' => AutomationRun::WAITING, 'resume_at' => now(), 'updated_at' => now()]));
        }
        $this->info("automations:reap-stuck: {$unknown} step(s) marked unknown, {$requeued} run(s) handed back.");

        return self::SUCCESS;
    }
}
