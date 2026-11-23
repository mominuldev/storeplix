<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * PHASE-7 §2.1 enforcement matrix, one dataset row per enforced row: at the limit → 402 with `details.<key>` and
 * `details.upgrade_plan`; below the limit → success; unlimited → success. Limits are lowered on the seeded plans to
 * keep fixtures small (the upgrade hint is computed from the same rows). `sms_per_month` refuses nothing over HTTP
 * (the SMS is skipped, P5-26: covered by the Sms tests); features without a module are not enforced (Phase 8).
 */
#[Group('billing')]
#[Group('plans')]
class PlanEnforcementTest extends TestCase
{
    use BillingFixtures, CommerceFixtures, RefreshDatabase;

    private bool $madeFirstProduct = false;

    private int $n = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        config(['couriers.fake' => true]);
        Http::fake();
    }

    /** @return iterable<string, array{string, string, ?string, string}> key, plan, limit override, expected upgrade plan */
    public static function rows(): iterable
    {
        yield 'products' => ['products', 'free', '1', 'starter'];
        yield 'staff_seats' => ['staff_seats', 'free', '0', 'starter'];
        yield 'orders_per_month' => ['orders_per_month', 'free', '0', 'starter'];
        yield 'courier_connections' => ['courier_connections', 'free', '0', 'starter'];
        yield 'custom_domains' => ['custom_domains', 'starter', '0', 'growth'];
        yield 'custom_domain (feature)' => ['custom_domain', 'free', null, 'starter'];
        yield 'bulk_courier_booking (feature)' => ['bulk_courier_booking', 'free', null, 'starter'];
        yield 'profit_reports (feature)' => ['profit_reports', 'starter', null, 'growth'];
    }

    #[DataProvider('rows')]
    public function test_enforcement_row(string $key, string $plan, ?string $limit, string $upgrade): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->onPlan($tenant, $plan);
        if ($limit !== null) {
            $this->setLimit($plan, $key, (int) $limit);
        }

        $response = $this->attempt($key, $tenant, $store, $h);
        $response->assertStatus(402)->assertJsonPath('error.code', $limit !== null ? 'plan_limit_reached' : 'feature_not_in_plan')
            ->assertJsonPath('error.details.upgrade_plan', [$upgrade]);
        $limit !== null ? $response->assertJsonStructure(['error' => ['details' => [$key]]]) : $response->assertJsonPath('error.details.feature', [$key]);

        // Below the limit / with the feature → success.
        $this->onPlan($tenant, $upgrade);
        if ($limit !== null) {
            $this->setLimit($upgrade, $key, null); // unlimited → success too
        }
        $ok = $this->attempt($key, $tenant, $store, $h);
        $this->assertNotSame(402, $ok->status(), "{$key} on {$upgrade}: ".$ok->getContent());
        $key === 'bulk_courier_booking' ? $ok->assertStatus(422) : $this->assertLessThan(300, $ok->status(), (string) $ok->getContent());
    }

    /** The plan gate comes before body validation: an empty / invalid body on a plan without the feature is 402, not 422. */
    public function test_bulk_booking_gate_precedes_validation(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->onPlan($tenant, 'free');
        foreach ([[], ['provider' => 'nope', 'order_ids' => 'x']] as $body) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", $body)->assertStatus(402)
                ->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.upgrade_plan', ['starter']);
        }
        $this->onPlan($tenant, 'starter');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_hint_is_omitted_when_no_plan_qualifies(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->onPlan($tenant, 'growth');
        foreach (['free', 'starter', 'growth'] as $code) {
            $this->setLimit($code, 'products', 0);
        }
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products", $this->simpleProduct())->assertStatus(402)
            ->assertJsonMissingPath('error.details.upgrade_plan')->assertJsonPath('error.details.products.0', 'Your plan allows 0 products.');
    }

    public function test_downgrade_is_visible_to_the_gate_immediately(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->onPlan($tenant, 'growth');
        $this->assertTrue(FeatureGate::allows($tenant, Feature::ProfitReports)); // cached
        $this->inTenant($tenant, fn () => Subscription::query()->first()->forceFill(['plan_id' => Plan::query()->where('code', 'starter')->value('id')])->save());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/reports/profit")->assertStatus(402);
    }

    private function attempt(string $key, Tenant $tenant, Store $store, array $h): TestResponse
    {
        $n = ++$this->n;

        return match ($key) {
            'products' => $this->attemptProduct($h, $store),
            'staff_seats' => $this->api($h, 'POST', '/api/v1/staff/invitations', ['email' => "invitee{$n}@example.com", 'role' => 'staff']),
            'orders_per_month' => $this->manual($h, $store, $this->manualBody($this->stocked($h, $store)[1], 1, ['notify_customer' => false]), (string) Str::ulid()),
            'courier_connections' => $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/couriers/steadfast", ['mode' => 'live', 'credentials' => ['api_key' => 'sf-key-'.$n, 'secret_key' => 'sf-secret']]),
            'custom_domains', 'custom_domain' => $this->addDomain($h, $store, "shop{$n}.localhost"),
            'bulk_courier_booking' => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [(string) Str::ulid()]]),
            'profit_reports' => $this->api($h, 'GET', "/api/v1/stores/{$store->id}/reports/profit"),
        };
    }

    private function attemptProduct(array $h, Store $store): TestResponse
    {
        if (! $this->madeFirstProduct) {
            $this->madeFirstProduct = true;
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products", $this->simpleProduct('First'))->assertCreated();
        }

        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products", $this->simpleProduct('Next '.uniqid()));
    }

    private function setLimit(string $plan, string $key, ?int $value): void
    {
        $row = Plan::query()->where('code', $plan)->firstOrFail();
        $row->limits = [$key => $value] + $row->limits;
        $row->save();
        Tenant::query()->pluck('id')->each(fn ($id) => FeatureGate::forget($id));
    }
}
