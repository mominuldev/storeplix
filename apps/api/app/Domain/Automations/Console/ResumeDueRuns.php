<?php

declare(strict_types=1);

namespace App\Domain\Automations\Console;

use App\Domain\Automations\Jobs\ResumeRun;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `automations:resume-due` (every minute, P86-23). Discovery on the platform connection, then per tenant the
 * conditional UPDATE `waiting → running WHERE resume_at <= now()`: only the command run that moved a row dispatches
 * ResumeRun, so running it twice resumes each run once (S129).
 */
class ResumeDueRuns extends Command
{
    protected $signature = 'automations:resume-due {--sync : run the jobs inline}';

    protected $description = 'Resume waiting automation runs that are due';

    public function handle(TenantContext $context): int
    {
        // cross-tenant: scheduler discovery (platform connection); the claim runs inside each tenant.
        $rows = AutomationRun::withoutTenancy()->where('status', AutomationRun::WAITING)->where('resume_at', '<=', now())
            ->orderBy('resume_at')->limit(1000)->get(['id', 'tenant_id']);
        $total = 0;
        foreach ($rows->groupBy('tenant_id') as $tenantId => $group) {
            $context->run((string) $tenantId, function () use ($group, &$total) {
                foreach ($group as $row) {
                    $moved = AutomationRun::query()->whereKey($row->id)->where('status', AutomationRun::WAITING)->where('resume_at', '<=', now())
                        ->update(['status' => AutomationRun::RUNNING, 'resume_at' => null, 'updated_at' => now()]);
                    if ($moved === 1) {
                        $job = new ResumeRun((string) $row->id);
                        $this->option('sync') ? dispatch_sync($job) : dispatch($job);
                        $total++;
                    }
                }
            });
        }
        $this->info("automations:resume-due: {$total} resumed.");

        return self::SUCCESS;
    }
}
