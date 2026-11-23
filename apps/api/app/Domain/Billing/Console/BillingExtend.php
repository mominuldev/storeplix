<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Ops\ExtendSubscription;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Shared\Http\ApiException;

/** Thin caller of the shared Action (PHASE-8-1 P8-7). */
class BillingExtend extends BillingOpsCommand
{
    protected $signature = 'billing:extend {tenant} {--days=} {--reason=} {--force}';

    protected $description = 'Move current_period_end (and trial_ends_at while trialing, grace_ends_at while past_due) forward';

    public function handle(ExtendSubscription $action): int
    {
        $days = (int) $this->option('days');
        if (! $this->guard() || $days < 1 || $days > 366) {
            $days < 1 || $days > 366 ? $this->error('--days must be 1–366.') : null;

            return self::FAILURE;
        }
        $tenant = $this->tenantOf((string) $this->argument('tenant'));
        if ($tenant === null) {
            $this->error('Tenant not found.');

            return self::FAILURE;
        }

        try {
            $action->handle($tenant->id, $days, OpsActor::system((string) $this->option('reason')));
        } catch (ApiException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
        $this->info("Extended by {$days} day(s).");

        return self::SUCCESS;
    }
}
