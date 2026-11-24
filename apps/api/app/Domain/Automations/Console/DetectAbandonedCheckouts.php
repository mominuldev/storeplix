<?php

declare(strict_types=1);

namespace App\Domain\Automations\Console;

use App\Domain\Automations\Engine\AutomationTriggers;
use App\Domain\Automations\Jobs\EvaluateAutomation;
use App\Domain\Automations\Models\Automation;
use App\Domain\Cart\Models\Cart;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `automations:detect-abandoned` (every 5 min, PHASE-8-6 §4.1, P86-13). Discovery on the platform connection
 * (cross-tenant: scheduler discovery of `on` recovery automations), then per tenant: carts `active` with ≥ 1 line and a
 * contact phone, not yet detected, idle ≥ delay_minutes; each is marked once by conditional UPDATE
 * (`recovery_detected_at IS NULL`) and only the worker that marked it dispatches EvaluateAutomation. Running it twice is
 * harmless. Not in plan → nothing is marked (P86-17).
 *
 * `--delay=N` (non-production only) overrides the idle minutes for e2e; `--sync` runs the jobs inline.
 */
class DetectAbandonedCheckouts extends Command
{
    protected $signature = 'automations:detect-abandoned {--sync : run the jobs inline} {--delay= : idle minutes override (non-production)}';

    protected $description = 'Detect abandoned checkouts and start the recovery flow';

    public function handle(TenantContext $context): int
    {
        // cross-tenant: scheduler discovery (platform connection); the work runs inside each tenant.
        $rows = Automation::withoutTenancy()->where('recipe', 'checkout_recovery')->where('status', Automation::ON)
            ->get(['id', 'tenant_id', 'store_id', 'settings']);
        $override = $this->option('delay');
        if ($override !== null && app()->environment('production')) {
            $this->error('--delay is not available in production.');

            return self::FAILURE;
        }
        $total = 0;
        foreach ($rows as $row) {
            $delay = $override !== null ? max(0, (int) $override) : (int) (((array) $row->settings)['delay_minutes'] ?? 30);
            $total += (int) $context->run((string) $row->tenant_id, fn () => $this->detect((string) $row->id, (string) $row->store_id, $delay));
        }
        $this->info("automations:detect-abandoned: {$total} checkout(s) detected.");

        return self::SUCCESS;
    }

    private function detect(string $automationId, string $storeId, int $delay): int
    {
        if (! AutomationTriggers::planAllows()) {
            return 0;
        }
        $ids = Cart::query()->where('store_id', $storeId)->where('status', Cart::ACTIVE)->whereNotNull('contact_phone')
            ->whereNull('recovery_detected_at')->where('last_activity_at', '<=', now()->subMinutes($delay))
            ->whereExists(fn ($q) => $q->selectRaw('1')->from('cart_items')->whereColumn('cart_items.cart_id', 'carts.id'))
            ->orderBy('last_activity_at')->limit((int) config('automations.detect_batch', 500))->pluck('id');
        $n = 0;
        foreach ($ids as $id) {
            $marked = Cart::query()->whereKey($id)->whereNull('recovery_detected_at')->where('status', Cart::ACTIVE)
                ->update(['recovery_detected_at' => now()]);
            if ($marked !== 1) {
                continue;
            }
            $job = new EvaluateAutomation($automationId, 'checkout.abandoned', 'cart', (string) $id);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
            $n++;
        }

        return $n;
    }
}
