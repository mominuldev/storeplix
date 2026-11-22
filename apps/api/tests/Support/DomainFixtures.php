<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Domains\Dns\FakeDnsResolver;
use App\Domain\Domains\DomainChecker;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Testing\TestResponse;

/** Phase 6 helpers: a shop on a plan, domains through the API, fake DNS records and provider states. */
trait DomainFixtures
{
    use CatalogFixtures;

    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function domainShop(string $plan = Plan::STARTER, string $role = TenantUser::ROLE_OWNER, string $slug = 'shop'): array
    {
        [$user, $tenant, $store, $h] = $this->shop($role, $slug);
        $this->onPlan($tenant, $plan);

        return [$user, $tenant, $store, $h];
    }

    protected function onPlan(Tenant $tenant, string $plan): void
    {
        $this->inTenant($tenant, fn () => Subscription::query()->update([
            'plan_id' => Plan::query()->where('code', $plan)->value('id'),
            'status' => Subscription::ACTIVE,
            'trial_ends_at' => null,
        ]));
        FeatureGate::forget($tenant->id);
    }

    protected function domainsUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/domains".$suffix;
    }

    protected function addDomain(array $h, Store $store, string $hostname): TestResponse
    {
        return $this->api($h, 'POST', $this->domainsUrl($store), ['hostname' => $hostname]);
    }

    protected function domainRow(Tenant $tenant, string $id): StoreDomain
    {
        return $this->inTenant($tenant, fn () => StoreDomain::query()->findOrFail($id));
    }

    /** Correct (or $ownership/$routing variant) fake DNS for $row. */
    protected function dnsFor(StoreDomain $row, string $ownership = 'correct', string $routing = 'correct'): void
    {
        $target = (string) config('domains.cname_target');
        FakeDnsResolver::set('_storeplix-verify.'.$row->hostname, 'TXT', match ($ownership) {
            'correct' => ['sp-verify='.$row->verification_token],
            'wrong' => ['sp-verify=someone-else'],
            default => null,
        });
        FakeDnsResolver::set($row->hostname, 'CNAME', match ($routing) {
            'correct' => [$target],
            'wrong' => ['elsewhere.example.net'],
            default => null,
        });
    }

    protected function check(Tenant $tenant, string $id): StoreDomain
    {
        return $this->inTenant($tenant, fn () => app(DomainChecker::class)->check(StoreDomain::query()->findOrFail($id)));
    }

    /** Adds a custom domain and drives it to `active` on the fakes. */
    protected function activeDomain(array $h, Tenant $tenant, Store $store, string $hostname): StoreDomain
    {
        $id = $this->addDomain($h, $store, $hostname)->assertCreated()->json('data.id');
        $row = $this->domainRow($tenant, $id);
        $this->dnsFor($row);
        FakeCustomHostnames::override($row->hostname, 'active', 'active');
        $row = $this->check($tenant, $id);
        if ($row->status === StoreDomain::STATUS_SSL_PROVISIONING) {
            $row = $this->check($tenant, $id);
        }
        $this->assertSame(StoreDomain::STATUS_ACTIVE, $row->status, 'domain did not become active');

        return $row;
    }

    /** Moves the domain's clock fields back by $hours (like POST /dev/domains/{id}/age). */
    protected function ageDomain(Tenant $tenant, string $id, int $hours): void
    {
        $this->inTenant($tenant, function () use ($id, $hours) {
            $row = StoreDomain::query()->findOrFail($id);
            $set = [];
            foreach (['verification_started_at', 'status_changed_at', 'first_failed_at', 'verified_at', 'unproven_since'] as $column) {
                if ($row->{$column} !== null) {
                    $set[$column] = $row->{$column}->copy()->subHours($hours);
                }
            }
            if ($set !== []) {
                StoreDomain::query()->whereKey($id)->update($set);
            }
        });
    }
}
