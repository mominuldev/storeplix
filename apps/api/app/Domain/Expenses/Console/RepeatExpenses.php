<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Console;

use App\Domain\Expenses\ExpenseService;
use App\Domain\Expenses\Jobs\GenerateRecurringExpenses;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `expenses:repeat` (hourly, PHASE-8-7 §6.2). Discovery on the platform connection: active series with
 * `next_on ≤ UTC date + 1 day` (the widest store-tz "today"), distinct stores; then per store, inside its tenant, only
 * series due in the store's own timezone dispatch GenerateRecurringExpenses (idempotent, S149).
 */
class RepeatExpenses extends Command
{
    protected $signature = 'expenses:repeat {--sync : run the jobs inline}';

    protected $description = 'Create the due occurrences of "Repeat every month" expenses';

    public function handle(TenantContext $context): int
    {
        $horizon = now('UTC')->addDay()->format('Y-m-d');
        // cross-tenant: scheduler discovery; generation runs inside each tenant.
        $stores = ExpenseRecurrence::withoutTenancy()->where('status', ExpenseRecurrence::ACTIVE)->where('next_on', '<=', $horizon)
            ->select(['tenant_id', 'store_id'])->distinct()->get();

        $dispatched = 0;
        foreach ($stores as $row) {
            $context->run((string) $row->tenant_id, function () use ($row, &$dispatched) {
                /** @var Store|null $store */
                $store = Store::query()->whereKey($row->store_id)->first();
                if ($store === null) {
                    return;
                }
                $due = ExpenseRecurrence::query()->where('store_id', $store->id)->where('status', ExpenseRecurrence::ACTIVE)
                    ->where('next_on', '<=', ExpenseService::today($store))->exists();
                if (! $due) {
                    return;
                }
                $job = new GenerateRecurringExpenses($store->id);
                $this->option('sync') ? dispatch_sync($job) : dispatch($job);
                $dispatched++;
            });
        }
        $this->info("expenses:repeat: {$dispatched} stores.");

        return self::SUCCESS;
    }
}
