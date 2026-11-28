<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** PHASE-8-9A charging helpers: plan limits, credits and the ledger invariant. */
trait SmsChargingFixtures
{
    /** Puts the tenant on `$code` and overrides that plan's SMS limits (null = unlimited). */
    protected function smsPlan(Tenant $tenant, string $code, ?int $transactional, ?int $marketing): void
    {
        $plan = Plan::query()->where('code', $code)->firstOrFail();
        $plan->limits = ['sms_per_month' => $transactional, 'campaign_sms_per_month' => $marketing] + (array) $plan->limits;
        $plan->save();
        $this->inTenant($tenant, fn () => Subscription::query()->whereIn('status', Subscription::CURRENT_STATUSES)
            ->update(['plan_id' => $plan->id, 'status' => Subscription::ACTIVE, 'trial_ends_at' => null]));
        FeatureGate::forget($tenant->id);
    }

    /** Grants credits through a ledger row (as staff would). */
    protected function giveCredits(Tenant $tenant, int $credits): void
    {
        $this->inTenant($tenant, fn () => DB::transaction(function () use ($credits) {
            $service = app(SmsCreditService::class);
            $service->append($service->lockAccount(), SmsCreditLedgerEntry::ADMIN_ADJUST, $credits, ['reason' => 'test grant', 'idempotency_key' => (string) Str::ulid()]);
        }));
    }

    protected function balance(Tenant $tenant): int
    {
        return $this->inTenant($tenant, fn () => app(SmsCreditService::class)->balance());
    }

    /** The account balance always equals the ledger sum (ADR 0026). */
    protected function assertLedgerMatches(Tenant $tenant): void
    {
        $this->inTenant($tenant, fn () => $this->assertSame(
            (int) SmsCreditLedgerEntry::query()->sum('credits'),
            app(SmsCreditService::class)->balance(),
        ));
    }

    /** `$count` sent transactional SMS this month (allowance usage). */
    protected function usedSms(Tenant $tenant, int $count): void
    {
        $rows = array_map(fn () => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'to' => '8801700000000',
            'purpose' => 'order_placed', 'template' => 'order_placed.bn', 'status' => 'sent', 'charged_from' => 'allowance',
            'created_at' => now(), 'updated_at' => now()], range(1, $count));
        $this->platformQuery(SmsMessage::class)->insert($rows);
    }
}
