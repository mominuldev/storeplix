<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\CommerceFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-7 §11 race tests (Postgres + pcntl; skipped elsewhere): S60 "parallel creates at limit − 1 → one success, one
 * 402" for invites, courier connections and custom domains (products: Catalog `test_plan_limit_race`), and P7-15
 * gapless invoice numbers under concurrent issuing. One process per test in CI (like the 5a/5b/6 race loop).
 */
class BillingRaceTest extends TestCase
{
    use BillingFixtures, CommerceFixtures, ForksRaces, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_invites_at_the_seat_limit_give_one_201_and_one_402(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, , $h] = $this->shop(); // Starter trial: 5 seats
            foreach (range(1, 4) as $i) {
                $this->api($h, 'POST', '/api/v1/staff/invitations', ['email' => "seat{$i}@example.com", 'role' => 'staff'])->assertCreated();
            }
            $results = $this->parallel(2, fn (int $i) => $this->api($h, 'POST', '/api/v1/staff/invitations', ['email' => "race{$i}@example.com", 'role' => 'staff'])->status());
            sort($results);
            $this->assertSame([201, 402], $results);
            $this->assertSame(5, $this->inTenant($tenant, fn () => StaffInvitation::query()->pending()->count()));
        } finally {
            $this->raceCleanup();
        }
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_courier_connects_at_the_limit_give_one_success_and_one_402(): void
    {
        $this->requirePostgresRace();
        try {
            config(['couriers.fake' => true]);
            [, $tenant, $store, $h] = $this->liveShop();
            $this->onPlan($tenant, 'free'); // courier_connections = 1
            $bodies = [
                ['steadfast', ['mode' => 'live', 'credentials' => ['api_key' => 'sf-race-key', 'secret_key' => 'sf-race-secret']]],
                ['pathao', ['mode' => 'sandbox', 'credentials' => ['client_id' => 'pathao-race', 'client_secret' => 'pathao-secret', 'username' => 'race@example.test', 'password' => 'Pathao-Pass-1']]],
            ];
            $results = $this->parallel(2, fn (int $i) => $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/couriers/{$bodies[$i][0]}", $bodies[$i][1])->status());
            sort($results);
            $this->assertSame([200, 402], $results);
            $this->assertSame(1, $this->inTenant($tenant, fn () => CourierAccount::query()->where('status', CourierAccount::CONNECTED)->count()));
        } finally {
            $this->raceCleanup();
        }
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_domain_adds_at_the_limit_give_one_201_and_one_402(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, $store, $h] = $this->domainShop('starter'); // custom_domains = 2
            $this->addDomain($h, $store, 'first.acme.com')->assertCreated();
            $results = $this->parallel(2, fn (int $i) => $this->addDomain($h, $store, "race{$i}.acme.com")->status());
            sort($results);
            $this->assertSame([201, 402], $results);
            $this->assertSame(2, $this->inTenant($tenant, fn () => StoreDomain::query()->where('type', StoreDomain::TYPE_CUSTOM)->count()));
        } finally {
            $this->raceCleanup();
        }
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_invoice_issuing_gives_gapless_consecutive_numbers(): void
    {
        $this->requirePostgresRace();
        try {
            $shops = [];
            foreach (range(0, 5) as $i) {
                [, $tenant, , $h] = $this->shop('owner', "inv{$i}");
                $shops[] = [$tenant, $h];
            }
            $results = $this->parallel(6, fn (int $i) => $this->changePlan($shops[$i][1], 'starter')->status());
            $this->assertSame(array_fill(0, 6, 201), $results);

            $numbers = [];
            foreach ($shops as [$tenant]) {
                $numbers[] = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole()->number);
            }
            sort($numbers);
            $year = now()->format('Y');
            $this->assertSame(array_map(fn (int $n) => sprintf('SP-%s-%06d', $year, $n), range(1, 6)), $numbers);
        } finally {
            $this->raceCleanup();
        }
    }
}
