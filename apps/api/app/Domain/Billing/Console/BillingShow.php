<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Subscription;

class BillingShow extends BillingOpsCommand
{
    protected $signature = 'billing:show {tenant}';

    protected $description = 'Subscription, open invoice and last payments of a tenant (no secrets)';

    public function handle(): int
    {
        $tenant = $this->tenantOf((string) $this->argument('tenant'));
        if ($tenant === null) {
            $this->error('Tenant not found.');

            return self::FAILURE;
        }

        return $this->inTenant($tenant->id, function () {
            $sub = Subscription::query()->with(['plan', 'scheduledPlan'])->latest()->get();
            $this->table(['id', 'status', 'plan', 'interval', 'trial_ends_at', 'period_end', 'scheduled', 'grace_ends_at', 'domain_grace'],
                $sub->map(fn (Subscription $s) => [$s->id, $s->status, $s->plan->code, $s->billing_interval, $s->trial_ends_at, $s->current_period_end,
                    $s->scheduledPlan?->code, $s->grace_ends_at, $s->domain_grace_ends_at])->all());
            $this->table(['number', 'kind', 'status', 'total', 'due_at', 'paid_at', 'void_reason'],
                BillingInvoice::query()->latest('issued_at')->limit(10)->get()->map(fn (BillingInvoice $i) => [$i->number, $i->kind, $i->status,
                    $i->total_amount, $i->due_at, $i->paid_at, $i->void_reason])->all());
            $this->table(['id', 'provider', 'status', 'amount', 'failure', 'duplicate', 'created_at'],
                BillingPayment::query()->latest()->limit(10)->get()->map(fn (BillingPayment $p) => [$p->id, $p->provider, $p->status, $p->amount,
                    $p->failure_code, $p->is_duplicate ? 'yes' : '', $p->created_at])->all());

            return self::SUCCESS;
        });
    }
}
