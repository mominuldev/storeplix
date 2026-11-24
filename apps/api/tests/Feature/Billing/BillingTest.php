<?php

namespace Tests\Feature\Billing;

use App\Domain\Billing\Exceptions\FeatureNotInPlan;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class BillingTest extends TestCase
{
    use RefreshDatabase;

    public function test_plans_are_public_and_seeded_from_contract(): void
    {
        $this->getJson('/api/v1/plans')
            ->assertOk()
            ->assertJsonPath('data.*.code', ['free', 'starter', 'growth'])
            ->assertJsonPath('data.1.price_amount', 49900)
            ->assertJsonPath('data.1.limits', ['orders_per_month' => 500, 'staff_seats' => 5, 'products' => 1000, 'courier_connections' => null, 'sms_per_month' => 2000, 'custom_domains' => 2, 'campaign_sms_per_month' => 1000, 'campaign_emails_per_month' => 5000]) // PHASE-8-5 P85-13
            ->assertJsonPath('data.2.limits.staff_seats', 15)
            ->assertJsonCount(10, 'data.2.features');
    }

    public function test_register_starts_a_14_day_starter_trial(): void
    {
        $this->freezeSecond();
        $tenantId = $this->postJson('/api/v1/auth/register', [
            'name' => 'Trial', 'email' => 't@example.com', 'phone' => '01711111111',
            'password' => 'secret123', 'password_confirmation' => 'secret123',
        ])->assertCreated()->json('data.user.tenants.0.id');

        $sub = Subscription::withoutTenancy()->where('tenant_id', $tenantId)->sole();
        $this->assertSame('trialing', $sub->status);
        $this->assertTrue($sub->trial_ends_at->equalTo(now()->addDays(14)));
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenantId)->where('action', 'subscription.trial_started')->exists());
    }

    public function test_subscription_and_features_endpoints_by_role(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);

        $this->withHeaders($this->tenantHeaders($owner, $tenant))->getJson('/api/v1/subscription')
            ->assertOk()->assertJsonPath('data.status', 'trialing')->assertJsonPath('data.plan.code', 'starter');

        $this->flushHeaders()->withHeaders($this->tenantHeaders($staff, $tenant))->getJson('/api/v1/subscription')->assertForbidden();

        $this->getJson('/api/v1/features')
            ->assertOk()
            ->assertJsonPath('data.plan_code', 'starter')
            ->assertJsonPath('data.subscription_status', 'trialing')
            ->assertJsonPath('data.features.custom_domain', true)
            ->assertJsonPath('data.features.pos', false)
            ->assertJsonPath('data.limits.staff_seats', ['limit' => 5, 'used' => 1])
            ->assertJsonPath('data.limits.products', ['limit' => 1000, 'used' => 0]);
    }

    public function test_end_trials_moves_to_free_and_busts_cache(): void
    {
        [, $tenant] = $this->merchant();
        $this->assertTrue(FeatureGate::allows($tenant, Feature::CustomDomain)); // cached as starter

        $this->travel(15)->days();
        $this->artisan('subscriptions:end-trials')->assertExitCode(0);

        $sub = Subscription::withoutTenancy()->where('tenant_id', $tenant->id)->sole();
        $this->assertSame('active', $sub->status);
        $this->assertSame('free', $sub->plan->code);
        $this->assertNotNull($sub->current_period_end);
        $this->assertFalse(FeatureGate::allows($tenant, Feature::CustomDomain));
        $this->assertSame(50, FeatureGate::limit($tenant, Limit::OrdersPerMonth));
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'subscription.trial_ended')->exists());

        $this->expectException(FeatureNotInPlan::class);
        FeatureGate::assertAllows($tenant, Feature::CustomDomain);
    }

    public function test_no_subscription_falls_back_to_free(): void
    {
        [, $tenant] = $this->merchant();
        Subscription::withoutTenancy()->where('tenant_id', $tenant->id)->delete();

        $this->assertSame('free', FeatureGate::plan($tenant)['code']);
        $this->assertSame(5, FeatureGate::limit($tenant, Limit::StaffSeats));
    }
}
