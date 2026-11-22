<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Billing\Models\Plan;
use App\Domain\Domains\Dns\FakeDnsResolver;
use App\Domain\Domains\Jobs\CheckDomainJob;
use App\Domain\Domains\Jobs\DeleteProviderHostnameJob;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Domains\Providers\CloudflareCustomHostnames;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\DomainPlatformLookup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\TestCase;

/** PHASE-6 §2 + §10 "Jobs and commands": scheduler discovery, the state machine on fakes, timeouts, expiry, reclaim. */
#[Group('domains')]
class DomainLifecycleTest extends TestCase
{
    use DomainFixtures, RefreshDatabase;

    private function provider(): FakeCustomHostnames
    {
        return app(FakeCustomHostnames::class);
    }

    public function test_the_scheduler_alone_takes_a_domain_to_active(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id));

        // not due yet (first check ran on add; next in 1 min)
        $this->artisan('domains:check')->expectsOutputToContain('Dispatched 0')->assertSuccessful();
        $this->travel(2)->minutes();
        $this->artisan('domains:check')->expectsOutputToContain('Dispatched 1')->assertSuccessful();
        $row = $this->domainRow($tenant, $id);
        $this->assertSame('ssl_provisioning', $row->status);
        $this->assertStringStartsWith('fake_', (string) $row->provider_hostname_id);
        $this->assertSame('fake', $row->provider);
        $this->assertNotNull($row->verified_at);

        for ($i = 0; $i < 2; $i++) {
            $this->travel(3)->minutes();
            $this->artisan('domains:check')->assertSuccessful();
        }
        $row = $this->domainRow($tenant, $id);
        $this->assertSame('active', $row->status);
        $this->assertNotNull($row->activated_at);
        $this->assertNull($row->failure_code);
        $this->assertTrue($row->next_check_at->between(now()->addHours(23), now()->addHours(25)));
        Mail::assertQueued(DomainStatusMail::class, 1);
    }

    public function test_discovery_dispatches_one_job_per_due_custom_row_with_its_tenant(): void
    {
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, $tenantB, $storeB, $hB] = $this->domainShop(slug: 'b');
        $a = $this->addDomain($hA, $storeA, 'shop.a-example.com')->json('data.id');
        $b = $this->addDomain($hB, $storeB, 'shop.b-example.com')->json('data.id');
        $this->addDomain($hB, $storeB, 'www.b-example.com');
        $this->inTenant($tenantB, fn () => StoreDomain::query()->where('hostname', 'www.b-example.com')->update(['next_check_at' => now()->addHour()]));

        Queue::fake();
        $this->travel(2)->minutes();
        $this->artisan('domains:check')->assertSuccessful();
        Queue::assertPushed(CheckDomainJob::class, 2);
        Queue::assertPushed(CheckDomainJob::class, fn ($j) => $j->domainId === $a && $j->tenantId === $tenantA->id);
        Queue::assertPushed(CheckDomainJob::class, fn ($j) => $j->domainId === $b && $j->tenantId === $tenantB->id);
    }

    public function test_cadence_is_recorded_on_every_check(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $row = $this->domainRow($tenant, $id);
        $this->assertSame(1, $row->check_attempts);
        $this->assertEqualsWithDelta(now()->addMinute()->timestamp, $row->next_check_at->timestamp, 2);
        $this->assertSame('txt_missing', $row->failure_code);
        $this->assertSame('fail', $row->last_check['outcome']);
        $this->assertEqualsCanonicalizing(['cloudflare' => 'ok', 'google' => 'ok'], $row->last_check['resolvers']);

        $row = $this->check($tenant, $id);
        $this->assertEqualsWithDelta(now()->addMinutes(5)->timestamp, $row->next_check_at->timestamp, 2);
        $row = $this->check($tenant, $id);
        $this->assertEqualsWithDelta(now()->addMinutes(15)->timestamp, $row->next_check_at->timestamp, 2);
        $row = $this->check($tenant, $id);
        $this->assertEqualsWithDelta(now()->addMinutes(30)->timestamp, $row->next_check_at->timestamp, 2);
        // capped at the 72 h deadline
        $this->ageDomain($tenant, $id, 72); // at the deadline → fails
        $this->assertSame('verification_failed', $this->check($tenant, $id)->status);
    }

    public function test_72_hour_timeout_fails_and_emails(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id), 'correct', 'wrong');
        $this->ageDomain($tenant, $id, 71);
        $this->assertSame('pending_verification', $this->check($tenant, $id)->status);
        $this->ageDomain($tenant, $id, 2);
        $row = $this->check($tenant, $id);
        $this->assertSame('verification_failed', $row->status);
        $this->assertSame('verification_timeout', $row->failure_code);
        $this->assertStringContainsString('CNAME', (string) $row->failure_message);
        $this->assertNull($row->next_check_at);
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::FAILED);
        $this->assertSame([], $this->provider()->list(1)['items'], 'no provider hostname for an unproven host (S52)');
    }

    public function test_inconclusive_dns_never_fails_a_domain(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $row = $this->domainRow($tenant, $id);
        $this->dnsFor($row, 'missing', 'correct');
        FakeDnsResolver::set('_storeplix-verify.shop.acme.com', 'TXT', FakeDnsResolver::SERVFAIL);
        $this->ageDomain($tenant, $id, 100);
        $row = $this->check($tenant, $id);
        // §2.1: a failing or inconclusive check AFTER the 72 h deadline fails the domain; before it, nothing changes.
        $this->assertSame('verification_failed', $row->status);

        $id2 = $this->addDomain($h, $store, 'www.acme.com')->json('data.id');
        FakeDnsResolver::set('_storeplix-verify.www.acme.com', 'TXT', FakeDnsResolver::SERVFAIL);
        $row = $this->check($tenant, $id2);
        $this->assertSame('pending_verification', $row->status);
        $this->assertSame('dns_error', $row->failure_code);
        $this->assertSame('inconclusive', $row->last_check['outcome']);
    }

    public function test_active_domain_inconclusive_check_keeps_it_active(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        FakeDnsResolver::set('shop.acme.com', 'CNAME', FakeDnsResolver::SERVFAIL);
        $this->ageDomain($tenant, $row->id, 400);
        $row = $this->check($tenant, $row->id);
        $this->assertSame('active', $row->status);
        $this->assertNull($row->first_failed_at);
        $this->assertSame('dns_error', $row->failure_code);
    }

    public function test_ssl_24_hour_timeout_deletes_the_provider_hostname(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id));
        FakeCustomHostnames::override('shop.acme.com', 'pending', 'pending_validation');
        $row = $this->check($tenant, $id);
        $this->assertSame('ssl_provisioning', $row->status);
        $providerId = $row->provider_hostname_id;
        $this->assertNotNull($this->provider()->findByHostname('shop.acme.com'));

        $row = $this->check($tenant, $id);
        $this->assertEqualsWithDelta(now()->addMinutes(2)->timestamp, $row->next_check_at->timestamp, 2);
        $this->ageDomain($tenant, $id, 2);
        $row = $this->check($tenant, $id);
        $this->assertEqualsWithDelta(now()->addMinutes(15)->timestamp, $row->next_check_at->timestamp, 2);
        $this->ageDomain($tenant, $id, 23);
        $row = $this->check($tenant, $id);
        $this->assertSame('verification_failed', $row->status);
        $this->assertSame('ssl_timeout', $row->failure_code);
        $this->assertNull($row->provider_hostname_id);
        $this->assertNull($this->provider()->get((string) $providerId), 'provider hostname deleted (sync queue)');
    }

    public function test_provider_final_failures(): void
    {
        [, $tenant, $store, $h] = $this->domainShop(Plan::GROWTH);
        foreach (['blocked' => ['blocked', 'pending_validation', 'provider_blocked'], 'moved' => ['moved', 'active', 'provider_moved'],
            'ssl' => ['active', 'validation_timed_out', 'ssl_validation_failed']] as $label => [$status, $ssl, $code]) {
            $id = $this->addDomain($h, $store, "{$label}.acme.com")->json('data.id');
            $this->dnsFor($this->domainRow($tenant, $id));
            $this->check($tenant, $id);
            FakeCustomHostnames::override("{$label}.acme.com", $status, $ssl);
            $row = $this->check($tenant, $id);
            $this->assertSame(['verification_failed', $code], [$row->status, $row->failure_code], $label);
            $this->assertNull($this->provider()->findByHostname("{$label}.acme.com"), $label);
        }
        // `fail-ssl.` hosts end with validation_timed_out on the fake
        $id = $this->addDomain($h, $store, 'fail-ssl.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id));
        $this->check($tenant, $id);
        $this->check($tenant, $id);
        $this->assertSame('ssl_validation_failed', $this->check($tenant, $id)->failure_code);
    }

    public function test_provider_create_is_idempotent_and_adopts_a_duplicate(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $existing = $this->provider()->create('shop.acme.com');
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id));
        $row = $this->check($tenant, $id);
        $this->assertSame('ssl_provisioning', $row->status);
        $this->assertSame($existing->id, $row->provider_hostname_id);
    }

    public function test_provider_errors_are_recorded_and_retried_then_fail_after_24_hours(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->dnsFor($this->domainRow($tenant, $id));
        config(['domains.cloudflare.api_token' => '', 'domains.cloudflare.zone_id' => '']);
        $this->app->instance(CustomHostnameProvider::class, new CloudflareCustomHostnames); // unconfigured → provider_error
        $row = $this->check($tenant, $id); // pending → verified → create fails (not configured)
        $this->assertSame('verified', $row->status);
        $this->assertSame('provider_error', $row->failure_code);
        $this->assertEqualsWithDelta(now()->addMinutes(2)->timestamp, $row->next_check_at->timestamp, 2);
        $this->ageDomain($tenant, $id, 25);
        $row = $this->check($tenant, $id);
        $this->assertSame(['verification_failed', 'provider_error'], [$row->status, $row->failure_code]);
    }

    public function test_active_failing_for_7_days_expires_with_fallback_delete_and_emails(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertOk();
        $providerId = $row->provider_hostname_id;

        FakeDnsResolver::set('shop.acme.com', 'CNAME', null);
        $row = $this->check($tenant, $row->id);
        $this->assertSame('active', $row->status);
        $this->assertSame('cname_missing', $row->failure_code);
        $this->assertNotNull($row->first_failed_at);
        $this->assertEqualsWithDelta(now()->addHours(6)->timestamp, $row->next_check_at->timestamp, 2);
        $this->check($tenant, $row->id); // same streak: no second "missing" email
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::DNS_MISSING);
        $this->assertSame(1, Mail::queued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::DNS_MISSING)->count());

        // a passing check clears the streak
        $this->dnsFor($row);
        $this->assertNull($this->check($tenant, $row->id)->first_failed_at);

        FakeDnsResolver::set('shop.acme.com', 'CNAME', null);
        $this->check($tenant, $row->id);
        $this->ageDomain($tenant, $row->id, 24 * 7);
        $row = $this->check($tenant, $row->id);
        $this->assertSame('expired', $row->status);
        $this->assertFalse($row->is_primary);
        $this->assertNull($row->provider_hostname_id);
        $this->assertNull($this->provider()->get((string) $providerId));
        $this->inTenant($tenant, fn () => $this->assertSame($store->slug.'.storeplix.test',
            StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->value('hostname')));
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::EXPIRED);
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::PRIMARY_FALLBACK);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.primary_changed')->where('meta->reason', 'expired')->count());
        $this->assertNull($this->platformQuery(AuditLog::class)->where('action', 'domain.primary_changed')->where('meta->reason', 'expired')->value('actor_id'));
    }

    public function test_ssl_lost_on_an_active_domain_counts_as_a_failing_check(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        FakeCustomHostnames::override('shop.acme.com', 'active', 'expired');
        $this->assertSame('ssl_lost', $this->check($tenant, $row->id)->failure_code);
        FakeCustomHostnames::override('shop.acme.com', 'moved', 'active');
        $this->assertSame('provider_moved', $this->check($tenant, $row->id)->failure_code);
    }

    #[Group('security')]
    public function test_reclaim_of_stale_hostnames(): void
    {
        Mail::fake();
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, $tenantB, $storeB, $hB] = $this->domainShop(slug: 'b');
        $old = $this->addDomain($hA, $storeA, 'shop.acme.com')->json('data.id');
        $this->ageDomain($tenantA, $old, 73);
        $this->assertSame('verification_failed', $this->check($tenantA, $old)->status);

        // 6 days after failing: still held
        $this->ageDomain($tenantA, $old, 24 * 6);
        $this->addDomain($hB, $storeB, 'shop.acme.com')->assertStatus(422)->assertJsonPath('error.code', 'domain_taken');
        // 8 days: released + new row for B
        $this->ageDomain($tenantA, $old, 24 * 2);
        $new = $this->addDomain($hB, $storeB, 'shop.acme.com')->assertCreated()->assertJsonPath('data.status', 'pending_verification')->json('data.id');
        $this->assertNotSame($old, $new);
        $this->inTenant($tenantA, fn () => $this->assertNull(StoreDomain::query()->find($old)));
        $released = $this->platformQuery(AuditLog::class)->where('action', 'domain.released')->first();
        $this->assertSame($tenantA->id, $released->tenant_id);
        $this->assertSame('system', $released->actor_type);
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::RELEASED);

        // an active host of another tenant is never reclaimable
        $active = $this->activeDomain($hA, $tenantA, $storeA, 'live.acme.com');
        $this->ageDomain($tenantA, $active->id, 400);
        $this->addDomain($hB, $storeB, 'live.acme.com')->assertStatus(422)->assertJsonPath('error.code', 'domain_taken');
    }

    #[Group('security')]
    public function test_a_squatter_rechecking_forever_cannot_keep_a_hostname(): void
    {
        // QA H-1: re-checking a failed row resets status_changed_at, never the reclaim clock (unproven_since).
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, $tenantB, $storeB, $hB] = $this->domainShop(slug: 'b');
        $squat = $this->addDomain($hA, $storeA, 'shop.victim.com')->json('data.id');
        $this->ageDomain($tenantA, $squat, 73);
        $this->assertSame('verification_failed', $this->check($tenantA, $squat)->status);
        $failedAt = $this->domainRow($tenantA, $squat)->unproven_since;
        $this->assertNotNull($failedAt);

        // the squatter presses "Check now" every day for 8 days
        for ($day = 1; $day <= 8; $day++) {
            $this->ageDomain($tenantA, $squat, 24);
            $this->travel(1)->minutes(); // past the per-minute re-check limit
            $this->api($hA, 'POST', $this->domainsUrl($storeA, '/'.$squat.'/verify'))->assertOk();
            $row = $this->domainRow($tenantA, $squat);
            $this->assertTrue($row->unproven_since->lessThan(now()->subDays($day - 1)), 'reclaim clock not reset');
        }

        // the real owner can take it (and still has to prove TXT with their own token)
        $new = $this->addDomain($hB, $storeB, 'shop.victim.com')->assertCreated()->json('data.id');
        $this->inTenant($tenantA, fn () => $this->assertNull(StoreDomain::query()->find($squat)));
        $mine = $this->domainRow($tenantB, $new);
        $this->assertNull($mine->unproven_since);
        $this->dnsFor($mine);
        $this->assertSame('ssl_provisioning', $this->check($tenantB, $new)->status);
    }

    public function test_proving_ownership_again_resets_the_reclaim_clock(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->ageDomain($tenant, $id, 73);
        $this->check($tenant, $id);
        $this->assertNotNull($this->domainRow($tenant, $id)->unproven_since);
        $this->dnsFor($this->domainRow($tenant, $id));
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()->assertJsonPath('data.status', 'ssl_provisioning');
        $this->assertNull($this->domainRow($tenant, $id)->unproven_since);
    }

    #[Group('security')]
    public function test_another_domains_token_does_not_verify(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $a = $this->domainRow($tenant, $this->addDomain($h, $store, 'a.acme.com')->json('data.id'));
        $b = $this->domainRow($tenant, $this->addDomain($h, $store, 'b.acme.com')->json('data.id'));
        FakeDnsResolver::set('_storeplix-verify.b.acme.com', 'TXT', ['sp-verify='.$a->verification_token]);
        FakeDnsResolver::set('b.acme.com', 'CNAME', [(string) config('domains.cname_target')]);
        $this->assertSame('txt_mismatch', $this->check($tenant, $b->id)->failure_code);
    }

    public function test_delete_provider_hostname_job_treats_404_as_done_and_skips_referenced_ids(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        (new DeleteProviderHostnameJob('fake', 'fake_missing'))->handle(app(DomainPlatformLookup::class));
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        (new DeleteProviderHostnameJob('fake', (string) $row->provider_hostname_id))->handle(app(DomainPlatformLookup::class));
        $this->assertNotNull($this->provider()->get((string) $row->provider_hostname_id), 'still referenced → kept');
    }

    public function test_reconcile_deletes_old_orphans_only(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        FakeCustomHostnames::backdate((string) $row->provider_hostname_id, 5);
        $orphan = $this->provider()->create('orphan.example.com');
        FakeCustomHostnames::backdate($orphan->id, 2);
        $young = $this->provider()->create('young.example.com');

        $this->artisan('domains:reconcile-provider', ['--dry-run' => true])->expectsOutputToContain('Found 1 orphan')->assertSuccessful();
        $this->assertNotNull($this->provider()->findByHostname('orphan.example.com'));
        $this->artisan('domains:reconcile-provider')->expectsOutputToContain('Deleted 1 orphan')->assertSuccessful();
        $this->assertNull($this->provider()->findByHostname('orphan.example.com'));
        $this->assertNotNull($this->provider()->findByHostname('young.example.com'));
        $this->assertNotNull($this->provider()->get((string) $row->provider_hostname_id));
        $this->assertNotNull($young);
    }

    public function test_store_delete_enqueues_provider_deletes(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        Queue::fake();
        $this->inTenant($tenant, fn () => Store::query()->findOrFail($store->id)->delete());
        Queue::assertPushed(DeleteProviderHostnameJob::class, fn ($j) => $j->providerHostnameId === $row->provider_hostname_id && $j->formerDomainId === $row->id);
    }

    public function test_suspend_and_reinstate(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertOk();

        $this->artisan('domains:suspend', ['hostname' => 'shop.acme.com', '--reason' => 'phishing'])->assertSuccessful();
        $row = $this->domainRow($tenant, $row->id);
        $this->assertSame(['suspended', false, 'suspended'], [$row->status, $row->is_primary, $row->failure_code]);
        $this->assertNotNull($row->provider_hostname_id, 'provider hostname kept');
        $this->assertNull($row->next_check_at);
        $this->assertSame('phishing', $this->platformQuery(AuditLog::class)->where('action', 'domain.suspended')->value('meta')['reason']);

        $this->artisan('domains:reinstate', ['hostname' => 'shop.acme.com'])->expectsOutputToContain('is now active')->assertSuccessful();
        $this->assertSame('active', $this->domainRow($tenant, $row->id)->status);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.reinstated')->count());

        // reinstate with DNS gone → pending with a fresh window
        $this->artisan('domains:suspend', ['hostname' => 'shop.acme.com'])->assertSuccessful();
        FakeDnsResolver::set('shop.acme.com', 'CNAME', null);
        $this->artisan('domains:reinstate', ['hostname' => 'shop.acme.com'])->expectsOutputToContain('pending_verification')->assertSuccessful();
        $this->artisan('domains:reinstate', ['hostname' => 'unknown.example.com'])->assertFailed();
    }
}
