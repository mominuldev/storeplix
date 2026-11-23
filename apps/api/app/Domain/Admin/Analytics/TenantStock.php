<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Models\Tenant;

/**
 * The stock part of one tenant on one day (PHASE-8-2 §3, P82-7, P82-12): effective plan, interval, subscription and
 * tenant status, MRR and the comp flag, plus the partition category used by the platform row.
 */
final class TenantStock
{
    public const PAYING = 'paying';

    public const TRIALING = 'trialing';

    public const COMP = 'comp';

    public const FREE = 'free';

    public const SUSPENDED = 'suspended';

    /**
     * P82-7 from the current state. `$sub` = the current subscription (trialing|active|past_due) or null.
     *
     * @param  array{status: string, interval: string|null, plan_code: string, price_amount: int, price_yearly_amount: int|null, has_paid_invoice: bool}|null  $sub
     * @return array{plan_code: string|null, billing_interval: string|null, subscription_status: string|null, tenant_status: string, mrr_amount: int, is_comp: bool}
     */
    public static function fromCurrent(string $tenantStatus, ?array $sub): array
    {
        if ($sub === null) {
            return self::row(Plan::FREE, null, null, $tenantStatus, 0, false);
        }
        $paidPlan = $sub['plan_code'] !== Plan::FREE;
        $billable = in_array($sub['status'], [Subscription::ACTIVE, Subscription::PAST_DUE], true) && $paidPlan;
        $isComp = $billable && ! $sub['has_paid_invoice'];
        $mrr = $billable && ! $isComp && $tenantStatus === Tenant::STATUS_ACTIVE
            ? self::monthly($sub['interval'], $sub['price_amount'], $sub['price_yearly_amount'])
            : 0;

        return self::row($sub['plan_code'], $paidPlan ? $sub['interval'] : null, $sub['status'], $tenantStatus, $mrr, $isComp);
    }

    /** Recurring list price normalised to a month (year → floor(yearly / 12): Starter 41 583, Growth 124 916). */
    public static function monthly(?string $interval, int $priceAmount, ?int $yearlyAmount): int
    {
        return $interval === Plan::YEAR ? intdiv((int) $yearlyAmount, 12) : $priceAmount;
    }

    /**
     * Partition (P82-12): `active = paying + trialing + comp + free`; suspended shops are outside it.
     *
     * @param  object|array<string, mixed>  $row  a tenant_daily_metrics row
     */
    public static function category(object|array $row): string
    {
        $row = (object) $row;

        return match (true) {
            $row->tenant_status !== Tenant::STATUS_ACTIVE => self::SUSPENDED,
            (int) $row->mrr_amount > 0 => self::PAYING,
            $row->subscription_status === Subscription::TRIALING => self::TRIALING,
            (bool) $row->is_comp => self::COMP,
            default => self::FREE,
        };
    }

    /** @return array{plan_code: string|null, billing_interval: string|null, subscription_status: string|null, tenant_status: string, mrr_amount: int, is_comp: bool} */
    public static function row(?string $plan, ?string $interval, ?string $status, string $tenantStatus, int $mrr, bool $comp): array
    {
        return [
            'plan_code' => $plan,
            'billing_interval' => $interval,
            'subscription_status' => $status,
            'tenant_status' => $tenantStatus,
            'mrr_amount' => $mrr,
            'is_comp' => $comp,
        ];
    }
}
