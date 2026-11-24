<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Console;

use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `fraud:resolve-stale` (every 5 minutes, PHASE-8-8 §5.1/§9): an order held `checking` for more than 10 minutes lost
 * its CheckOrderRisk job; re-run the check (own-shop data only) inside its tenant. The check is idempotent (S157).
 */
class ResolveStaleChecks extends Command
{
    protected $signature = 'fraud:resolve-stale';

    protected $description = 'Re-run lost fake-order guard checks (orders held "checking" for over 10 minutes)';

    public function handle(TenantContext $context, FraudGuard $guard): int
    {
        $before = now()->subMinutes((int) config('fraud_guard.stale_minutes', 10));
        // cross-tenant: scheduler discovery of stale holds; each check runs inside its own tenant.
        $rows = Order::withoutTenancy()->where('guard_hold', FraudGuard::CHECKING)->where('guard_hold_at', '<', $before)
            ->orderBy('guard_hold_at')->limit(500)->get(['id', 'tenant_id']);

        $resolved = 0;
        foreach ($rows as $row) {
            $context->run((string) $row->tenant_id, function () use ($guard, $row, &$resolved) {
                if ($guard->check((string) $row->id) === null) {
                    // A check exists but the hold stayed (e.g. a crash between writes): clear the orphan hold.
                    Order::query()->whereKey($row->id)->where('guard_hold', FraudGuard::CHECKING)->update(['guard_hold' => null, 'guard_hold_at' => null]);
                }
                $resolved++;
            });
        }
        $this->info("fraud:resolve-stale: {$resolved} orders.");

        return self::SUCCESS;
    }
}
