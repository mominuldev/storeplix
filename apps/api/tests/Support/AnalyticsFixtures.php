<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Admin\Analytics\AnalyticsDays;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * Phase 8.2 analytics fixtures (PHASE-8-2 §10): tenants, stores, subscriptions, paid invoices and orders written as raw
 * rows through the platform connection (pgsql_admin with RLS on), so a test controls every timestamp. Times are given
 * as Dhaka wall clock (`'2026-11-21 10:00'`) unless they end in `Z`.
 */
trait AnalyticsFixtures
{
    private int $fixtureSeq = 0;

    protected function at(string $time): CarbonImmutable
    {
        return str_ends_with($time, 'Z')
            ? CarbonImmutable::parse($time)->utc()
            : CarbonImmutable::parse($time, AnalyticsDays::tz())->utc();
    }

    /** Freezes the clock at a Dhaka wall-clock time. */
    protected function travelToDhaka(string $time): void
    {
        $this->travelTo($this->at($time));
    }

    protected function id(): string
    {
        return strtolower((string) Str::ulid());
    }

    protected function planId(string $code): string
    {
        return (string) $this->platformTable('plans')->where('code', $code)->value('id');
    }

    /** A tenant with its store; returns the tenant id. */
    protected function aTenant(string $name, string $createdAt, string $status = 'active', ?string $publishedAt = null): string
    {
        $id = $this->id();
        $at = $this->at($createdAt);
        $this->platformTable('tenants')->insert(['id' => $id, 'name' => $name, 'status' => $status, 'created_at' => $at, 'updated_at' => $at,
            'suspended_at' => $status === 'suspended' ? $at : null]);
        $slug = Str::slug($name).'-'.(++$this->fixtureSeq).'-'.substr($id, -4);
        $this->platformTable('stores')->insert([
            'id' => $this->id(), 'tenant_id' => $id, 'name' => $name.' Store', 'slug' => $slug, 'status' => 'active', 'country' => 'BD',
            'currency' => 'BDT', 'business_categories' => '[]', 'timezone' => 'Asia/Dhaka',
            'published_at' => $publishedAt !== null ? $this->at($publishedAt) : null, 'created_at' => $at, 'updated_at' => $at,
        ]);

        return $id;
    }

    /** @param array<string, mixed> $extra */
    protected function aSubscription(string $tenantId, string $plan, string $status, string $interval = 'month', ?string $trialEndsAt = null, string $createdAt = '2026-01-01 10:00', array $extra = []): string
    {
        $id = $this->id();
        $at = $this->at($createdAt);
        $this->platformTable('subscriptions')->insert(array_merge([
            'id' => $id, 'tenant_id' => $tenantId, 'plan_id' => $this->planId($plan), 'status' => $status, 'billing_interval' => $interval,
            'trial_ends_at' => $trialEndsAt !== null ? $this->at($trialEndsAt) : null,
            'current_period_start' => $at, 'current_period_end' => $at->addMonth(),
            'cancel_at_period_end' => false, 'notices' => '{}', 'created_at' => $at, 'updated_at' => $at,
            'grace_ends_at' => $status === Subscription::PAST_DUE ? $at->addMonths(2) : null,
            'ended_at' => in_array($status, [Subscription::EXPIRED, Subscription::CANCELLED], true) ? $at : null,
        ], $extra));

        return $id;
    }

    /** @param array<string, mixed> $values */
    protected function updateSubscription(string $id, array $values): void
    {
        if (isset($values['plan'])) {
            $values['plan_id'] = $this->planId((string) $values['plan']);
            unset($values['plan']);
        }
        if (($values['status'] ?? null) === Subscription::PAST_DUE) {
            $values['grace_ends_at'] ??= now()->addDays(7);
        }
        if (in_array($values['status'] ?? null, [Subscription::EXPIRED, Subscription::CANCELLED], true)) {
            $values['ended_at'] ??= now();
        }
        $this->platformTable('subscriptions')->where('id', $id)->update($values);
    }

    /** A paid invoice (+ the succeeded payment that paid it). */
    protected function aPaidInvoice(string $tenantId, string $subscriptionId, string $plan, string $paidAt, string $interval = 'month', ?string $periodStart = null, ?string $periodEnd = null, string $provider = 'bkash', ?int $total = null): string
    {
        $id = $this->id();
        $paid = $this->at($paidAt);
        $start = $periodStart !== null ? $this->at($periodStart) : $paid;
        $end = $periodEnd !== null ? $this->at($periodEnd) : ($interval === Plan::YEAR ? $start->addYear() : $start->addMonth());
        $total ??= (int) ($this->platformTable('plans')->where('code', $plan)->value($interval === Plan::YEAR ? 'price_yearly_amount' : 'price_amount') ?: 1000);
        $paymentId = $this->id();
        $this->platformTable('billing_invoices')->insert([
            'id' => $id, 'tenant_id' => $tenantId, 'subscription_id' => $subscriptionId, 'number' => 'SP-T-'.(++$this->fixtureSeq).'-'.substr($id, -6),
            'kind' => 'new', 'status' => 'paid', 'plan_id' => $this->planId($plan), 'interval' => $interval, 'currency' => 'BDT',
            'subtotal_amount' => $total, 'tax_amount' => 0, 'total_amount' => $total, 'tax_rate_bps' => 0, 'credit_amount' => 0,
            'lines' => '[]', 'bill_to' => '{}', 'period_start' => $start, 'period_end' => $end, 'issued_at' => $paid, 'due_at' => $paid,
            'paid_at' => $paid, 'paid_late' => false, 'paid_payment_id' => $paymentId, 'reminders' => '[]', 'created_at' => $paid, 'updated_at' => $paid,
        ]);
        $this->platformTable('billing_payments')->insert([
            'id' => $paymentId, 'tenant_id' => $tenantId, 'invoice_id' => $id, 'provider' => $provider, 'status' => 'succeeded',
            'amount' => $total, 'currency' => 'BDT', 'is_duplicate' => false, 'expires_at' => $paid, 'verified_at' => $paid,
            'created_at' => $paid, 'updated_at' => $paid,
        ]);

        return $id;
    }

    protected function anOrder(string $tenantId, string $status, int $total, string $placedAt, string $currency = 'BDT'): string
    {
        $id = $this->id();
        $storeId = (string) $this->platformTable('stores')->where('tenant_id', $tenantId)->value('id');
        $at = $this->at($placedAt);
        $n = ++$this->fixtureSeq;
        $this->platformTable('orders')->insert([
            'id' => $id, 'tenant_id' => $tenantId, 'store_id' => $storeId, 'number' => 'A'.(1000 + $n), 'sequence' => 1000 + $n,
            'status' => $status, 'payment_status' => 'unpaid', 'payment_method' => 'cod', 'created_via' => 'storefront', 'channel' => 'website',
            'customer_name' => 'Buyer', 'customer_phone' => '8801700000000', 'shipping_address' => '{}', 'district_code' => 'dhaka',
            'currency' => $currency, 'subtotal_amount' => $total, 'total_amount' => $total, 'shipping_zone_name' => 'Dhaka', 'tags' => '[]',
            'placed_at' => $at, 'created_at' => $at, 'updated_at' => $at,
        ]);

        return $id;
    }

    protected function aggregate(array $options = []): void
    {
        $this->artisan('analytics:aggregate', $options)->assertExitCode(0);
    }

    protected function tenantRow(string $tenantId, string $day): ?object
    {
        return $this->platformTable('tenant_daily_metrics')->where('tenant_id', $tenantId)->where('day', $day)->first();
    }

    protected function platformRow(string $day): ?object
    {
        return $this->platformTable('platform_daily_metrics')->where('day', $day)->first();
    }

    protected function analytics(User $staff, string $uri): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($staff))->getJson('/api/v1/'.$uri);
    }
}
