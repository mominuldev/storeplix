<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Billing\Models\Plan;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** P6-8 / §10: the one-primary partial unique index holds under concurrent "make primary" requests (Postgres). */
#[Group('domains')]
class DomainPrimaryRaceTest extends TestCase
{
    use DomainFixtures, ForksRaces, RefreshDatabase;

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_make_primary_keeps_one_primary(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, $tenant, $store, $h] = $this->domainShop(Plan::GROWTH);
            $ids = [
                $this->inTenant($tenant, fn () => StoreDomain::query()->where('store_id', $store->id)->value('id')),
                $this->activeDomain($h, $tenant, $store, 'a.acme.com')->id,
                $this->activeDomain($h, $tenant, $store, 'b.acme.com')->id,
            ];

            $results = $this->parallel(9, fn (int $i) => $this->api($h, 'POST', $this->domainsUrl($store, '/'.$ids[$i % 3].'/primary'))->status());
            $this->assertSame(array_fill(0, 9, 200), $results);
            $this->inTenant($tenant, fn () => $this->assertSame(1, StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->count()));
        } finally {
            $this->raceCleanup();
        }
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_remove_and_make_primary_do_not_deadlock(): void
    {
        // QA M-1: remove() and makePrimary() lock the store row first; no 40P01 → no 500.
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, $tenant, $store, $h] = $this->domainShop(Plan::GROWTH);
            $ids = [];
            foreach (['a', 'b', 'c', 'd'] as $label) {
                $ids[] = $this->activeDomain($h, $tenant, $store, "{$label}.acme.com")->id;
            }
            $this->api($h, 'POST', $this->domainsUrl($store, '/'.$ids[0].'/primary'))->assertOk();

            // removers of a/b (a is primary) race primary switches to b/c/d
            $results = $this->parallel(8, fn (int $i) => $i % 2 === 0
                ? $this->api($h, 'DELETE', $this->domainsUrl($store, '/'.$ids[intdiv($i, 2) % 2]))->status()
                : $this->api($h, 'POST', $this->domainsUrl($store, '/'.$ids[1 + intdiv($i, 2) % 3].'/primary'))->status());
            $this->assertNotContains(500, $results, implode(',', $results));
            foreach ($results as $status) {
                $this->assertContains($status, [200, 204, 404, 409]);
            }
            $this->inTenant($tenant, fn () => $this->assertSame(1, StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->count()));
        } finally {
            $this->raceCleanup();
        }
    }
}
