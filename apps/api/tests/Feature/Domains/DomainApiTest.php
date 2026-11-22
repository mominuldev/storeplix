<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Billing\Models\Plan;
use App\Domain\Domains\Jobs\CheckDomainJob;
use App\Domain\Domains\Jobs\DeleteProviderHostnameJob;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-6 §4.1 merchant endpoints: happy paths, validation (§4.0 codes), plan gate, roles, platform rows, primary. */
#[Group('domains')]
class DomainApiTest extends TestCase
{
    use DomainFixtures, RefreshDatabase, StorefrontContent;

    private const KEYS = [
        'id', 'hostname', 'display_hostname', 'type', 'status', 'is_primary', 'is_apex', 'routable', 'dns_records', 'ssl_status',
        'verification_started_at', 'verified_at', 'activated_at', 'status_changed_at', 'last_checked_at', 'next_check_at',
        'deadline_at', 'failure_code', 'failure_message', 'can_recheck', 'can_make_primary', 'can_remove', 'created_at', 'updated_at',
    ];

    public function test_list_shows_the_platform_row_first_with_meta(): void
    {
        [, , $store, $h] = $this->domainShop();
        $res = $this->api($h, 'GET', $this->domainsUrl($store))->assertOk();
        $res->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.hostname', $store->slug.'.storeplix.test')
            ->assertJsonPath('data.0.type', 'platform')
            ->assertJsonPath('data.0.status', 'active')
            ->assertJsonPath('data.0.is_primary', true)
            ->assertJsonPath('data.0.routable', true)
            ->assertJsonPath('data.0.dns_records', [])
            ->assertJsonPath('data.0.ssl_status', 'active')
            ->assertJsonPath('data.0.can_remove', false)
            ->assertJsonPath('data.0.can_recheck', false)
            ->assertJsonPath('meta', [
                'cname_target' => 'customers.storeplix.test', 'txt_prefix' => '_storeplix-verify', 'can_add' => true,
                'feature_enabled' => true, 'limit' => ['used' => 0, 'max' => 2],
            ]);
        $this->assertSame(self::KEYS, array_keys($res->json('data.0')));
    }

    public function test_add_creates_a_pending_row_with_dns_records_and_queues_the_first_check(): void
    {
        Queue::fake();
        [$user, $tenant, $store, $h] = $this->domainShop();
        $res = $this->addDomain($h, $store, '  Shop.Acme.COM. ')->assertCreated();
        $res->assertJsonPath('data.hostname', 'shop.acme.com')
            ->assertJsonPath('data.display_hostname', 'shop.acme.com')
            ->assertJsonPath('data.type', 'custom')
            ->assertJsonPath('data.status', 'pending_verification')
            ->assertJsonPath('data.is_primary', false)
            ->assertJsonPath('data.is_apex', false)
            ->assertJsonPath('data.routable', false)
            ->assertJsonPath('data.ssl_status', 'none')
            ->assertJsonPath('data.can_recheck', true)
            ->assertJsonPath('data.can_make_primary', false)
            ->assertJsonPath('data.can_remove', true);
        $this->assertSame(self::KEYS, array_keys($res->json('data')));
        $records = $res->json('data.dns_records');
        $this->assertSame(['purpose', 'type', 'name', 'name_relative', 'value', 'status', 'found'], array_keys($records[0]));
        $this->assertSame(['ownership', 'TXT', '_storeplix-verify.shop.acme.com', '_storeplix-verify.shop'], [$records[0]['purpose'], $records[0]['type'], $records[0]['name'], $records[0]['name_relative']]);
        $this->assertMatchesRegularExpression('/^sp-verify=[a-z2-7]{52}$/', $records[0]['value']);
        $this->assertSame(['routing', 'CNAME', 'shop.acme.com', 'shop', 'customers.storeplix.test', 'pending', []], array_values($records[1]));
        // deadline = verification start + 72 h
        $this->assertSame(now()->addHours(72)->format('Y-m-d H'), Carbon::parse($res->json('data.deadline_at'))->format('Y-m-d H'));

        $id = $res->json('data.id');
        Queue::assertPushed(CheckDomainJob::class, fn ($job) => $job->domainId === $id && $job->tenantId === $tenant->id && $job->queue === 'domains');
        $row = $this->domainRow($tenant, $id);
        $this->assertSame($user->id, $row->created_by);
        $this->assertNotNull($row->verification_started_at);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.added')->where('subject_id', $id)->count());
    }

    public function test_apex_and_idn_hosts(): void
    {
        [, , $store, $h] = $this->domainShop(Plan::GROWTH);
        $this->addDomain($h, $store, 'acme.com.bd')->assertCreated()
            ->assertJsonPath('data.is_apex', true)
            ->assertJsonPath('data.dns_records.0.name_relative', '_storeplix-verify')
            ->assertJsonPath('data.dns_records.1.name_relative', '@');
        $this->addDomain($h, $store, 'Bücher.example.com')->assertCreated()
            ->assertJsonPath('data.hostname', 'xn--bcher-kva.example.com')
            ->assertJsonPath('data.display_hostname', 'bücher.example.com');
    }

    public function test_validation_and_domain_error_codes(): void
    {
        [, , $store, $h] = $this->domainShop(Plan::GROWTH);
        $this->addDomain($h, $store, '')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->api($h, 'POST', $this->domainsUrl($store), [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->addDomain($h, $store, str_repeat('a', 301))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        foreach (['https://shop.acme.com', 'shop.acme.com/path', 'shop.acme.com:8080', '*.acme.com', 'a b.com', 'localhost', '127.0.0.1',
            '169.254.169.254', 'metadata.google.internal', 'shop', 'com.bd', 'co.uk', 'shop.notatld', 'xn--a.com', 'user@acme.com', 'shop.test'] as $bad) {
            $this->addDomain($h, $store, $bad)->assertStatus(422)->assertJsonPath('error.code', 'domain_invalid')
                ->assertJsonStructure(['error' => ['details' => ['hostname']]]);
        }
        foreach (['x.storeplix.com', 'storeplix.com', 'storeplix.test', 'evil.storeplix.test', 'customers.storeplix.test'] as $reserved) {
            $this->addDomain($h, $store, $reserved)->assertStatus(422)->assertJsonPath('error.code', 'domain_reserved');
        }
        Http::assertNothingSent();
    }

    public function test_taken_hosts(): void
    {
        [, , $store, $h] = $this->domainShop();
        [, , $other, $h2] = $this->domainShop(slug: 'other');
        $this->addDomain($h, $store, 'shop.acme.com')->assertCreated();
        $this->addDomain($h, $store, 'shop.acme.com')->assertStatus(422)->assertJsonPath('error.code', 'domain_taken');
        $this->addDomain($h2, $other, 'SHOP.acme.com')->assertStatus(422)->assertJsonPath('error.code', 'domain_taken');
        // the other store's platform host is taken too (and reserved here)
        $this->addDomain($h2, $other, $store->slug.'.storeplix.test')->assertStatus(422);
    }

    public function test_mass_assignment_has_no_effect(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->api($h, 'POST', $this->domainsUrl($store), [
            'hostname' => 'shop.acme.com', 'status' => 'active', 'is_primary' => true, 'type' => 'platform',
            'verification_token' => 'mine', 'provider_hostname_id' => 'x', 'tenant_id' => 'y',
        ])->assertCreated()->assertJsonPath('data.status', 'pending_verification')->assertJsonPath('data.is_primary', false)->json('data.id');
        $row = $this->domainRow($tenant, $id);
        $this->assertSame('custom', $row->type);
        $this->assertNotSame('mine', $row->verification_token);
        $this->assertNull($row->provider_hostname_id);
    }

    public function test_plan_gate(): void
    {
        [, $tenant, $store, $h] = $this->domainShop(Plan::FREE);
        $this->addDomain($h, $store, 'shop.acme.com')->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'GET', $this->domainsUrl($store))->assertOk()
            ->assertJsonPath('meta.feature_enabled', false)->assertJsonPath('meta.can_add', false)->assertJsonPath('meta.limit.max', 0);

        $this->onPlan($tenant, Plan::STARTER);
        $this->addDomain($h, $store, 'shop.acme.com')->assertCreated();
        $this->addDomain($h, $store, 'acme.com')->assertCreated();
        $this->addDomain($h, $store, 'www.acme.com')->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached');
        $this->api($h, 'GET', $this->domainsUrl($store))->assertJsonPath('meta.can_add', false)->assertJsonPath('meta.limit', ['used' => 2, 'max' => 2]);
    }

    public function test_a_starter_trial_may_add_a_domain(): void
    {
        [, , $store, $h] = $this->shop(); // a new tenant is on the 14-day Starter trial
        $this->addDomain($h, $store, 'shop.acme.com')->assertCreated();
    }

    public function test_staff_read_only_and_admin_writes(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);

        $this->api($staff, 'GET', $this->domainsUrl($store))->assertOk()
            ->assertJsonPath('data.1.can_remove', false)->assertJsonPath('data.1.can_recheck', false)
            ->assertJsonPath('data.1.can_make_primary', false)->assertJsonPath('meta.can_add', false);
        $this->api($staff, 'GET', $this->domainsUrl($store, '/'.$row->id))->assertOk()
            ->assertJsonPath('data.dns_records.0.value', 'sp-verify='.$row->verification_token);
        $this->addDomain($staff, $store, 'www.acme.com')->assertForbidden();
        $this->api($staff, 'POST', $this->domainsUrl($store), [])->assertForbidden(); // 403 before validation
        $this->api($staff, 'POST', $this->domainsUrl($store, '/'.$row->id.'/verify'))->assertForbidden();
        $this->api($staff, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertForbidden();
        $this->api($staff, 'DELETE', $this->domainsUrl($store, '/'.$row->id))->assertForbidden();

        $this->api($admin, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertOk();
        $this->addDomain($admin, $store, 'www.acme.com')->assertCreated();
    }

    public function test_show_and_full_lifecycle_through_recheck(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->assertCreated()->json('data.id');
        // the first (queued, sync in tests) check ran: records missing
        $this->api($h, 'GET', $this->domainsUrl($store, '/'.$id))->assertOk()
            ->assertJsonPath('data.status', 'pending_verification')
            ->assertJsonPath('data.failure_code', 'txt_missing')
            ->assertJsonPath('data.dns_records.0.status', 'missing')
            ->assertJsonPath('data.dns_records.1.status', 'missing');

        $row = $this->domainRow($tenant, $id);
        $this->dnsFor($row, 'wrong', 'correct');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()
            ->assertJsonPath('data.failure_code', 'txt_mismatch')
            ->assertJsonPath('data.dns_records.0.status', 'mismatch')
            ->assertJsonPath('data.dns_records.0.found', ['sp-verify=someone-else'])
            ->assertJsonPath('data.dns_records.1.status', 'ok');

        $this->dnsFor($row);
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()
            ->assertJsonPath('data.status', 'ssl_provisioning')
            ->assertJsonPath('data.ssl_status', 'pending')
            ->assertJsonPath('data.failure_code', null);
        // fake provider: active on the second poll
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()->assertJsonPath('data.status', 'ssl_provisioning');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()
            ->assertJsonPath('data.status', 'active')->assertJsonPath('data.ssl_status', 'active')
            ->assertJsonPath('data.routable', true)->assertJsonPath('data.can_make_primary', true);
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::LIVE && $m->hostname === 'shop.acme.com');
        $this->assertSame(4, $this->platformQuery(AuditLog::class)->where('action', 'domain.recheck_requested')->count());
        $this->assertSame(3, $this->platformQuery(AuditLog::class)->where('action', 'domain.status_changed')->count());
        $this->assertNull($this->platformQuery(AuditLog::class)->where('action', 'domain.status_changed')->get()
            ->first(fn ($a) => str_contains((string) json_encode($a->meta), (string) $row->verification_token)));
    }

    public function test_recheck_from_failed_resets_the_window(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->ageDomain($tenant, $id, 73);
        $this->assertSame('verification_failed', $this->check($tenant, $id)->status);
        $this->api($h, 'GET', $this->domainsUrl($store, '/'.$id))->assertJsonPath('data.failure_code', 'verification_timeout')
            ->assertJsonPath('data.deadline_at', null)->assertJsonPath('data.next_check_at', null);

        $res = $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk()
            ->assertJsonPath('data.status', 'pending_verification')
            ->assertJsonPath('data.failure_code', 'txt_missing');
        $this->assertTrue(now()->diffInMinutes(Carbon::parse($res->json('data.verification_started_at')), true) < 1);
    }

    public function test_platform_rows_are_locked(): void
    {
        [, , $store, $h] = $this->domainShop();
        $platform = $this->api($h, 'GET', $this->domainsUrl($store))->json('data.0.id');
        $this->api($h, 'DELETE', $this->domainsUrl($store, '/'.$platform))->assertStatus(409)->assertJsonPath('error.code', 'platform_domain_locked');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$platform.'/verify'))->assertStatus(409)->assertJsonPath('error.code', 'platform_domain_locked');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$platform.'/primary'))->assertOk()->assertJsonCount(1, 'data');
    }

    public function test_make_primary_rules_and_remove_falls_back(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->domainShop();
        $pending = $this->addDomain($h, $store, 'www.acme.com')->json('data.id');
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$pending.'/primary'))->assertStatus(409)->assertJsonPath('error.code', 'domain_not_active');

        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $list = $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertOk()->json('data');
        $this->assertSame([false, false, true], array_column($list, 'is_primary'));
        $this->assertSame(['platform', 'custom', 'custom'], array_column($list, 'type'));
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.primary_changed')->count());
        $this->inTenant($tenant, fn () => $this->assertSame(1, StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->count()));

        // Downgraded: making a custom domain primary needs the feature; the platform row doesn't.
        $this->onPlan($tenant, Plan::FREE);
        $platform = $list[0]['id'];
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$platform.'/primary'))->assertOk();
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        // existing domains keep working after a downgrade: re-check and remove are allowed
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/verify'))->assertOk();
        $this->onPlan($tenant, Plan::STARTER);
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/primary'))->assertOk();

        Queue::fake();
        $this->api($h, 'DELETE', $this->domainsUrl($store, '/'.$row->id))->assertNoContent();
        Queue::assertPushed(DeleteProviderHostnameJob::class, fn ($j) => $j->providerHostnameId === $row->provider_hostname_id && $j->provider === 'fake');
        $this->api($h, 'GET', $this->domainsUrl($store))->assertJsonPath('data.0.is_primary', true)->assertJsonCount(2, 'data');
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.removed')->count());
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.primary_changed')->where('meta->reason', 'removed')->count());
        Mail::assertQueued(DomainStatusMail::class, fn ($m) => $m->kind === DomainStatusMail::PRIMARY_FALLBACK && $m->fallbackHost === $store->slug.'.storeplix.test');
        $this->api($h, 'GET', $this->domainsUrl($store, '/'.$row->id))->assertNotFound();
    }

    public function test_recheck_throttle_returns_429_with_retry_after(): void
    {
        [, , $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        for ($i = 0; $i < 6; $i++) {
            $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertOk();
        }
        $res = $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/verify'))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->assertGreaterThan(0, $res->json('error.retry_after'));
        $this->assertNotNull($res->headers->get('Retry-After'));
    }

    public function test_suspended_domain_recheck_is_refused(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $this->artisan('domains:suspend', ['hostname' => 'shop.acme.com', '--reason' => 'phishing'])->assertSuccessful();
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$row->id.'/verify'))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'GET', $this->domainsUrl($store, '/'.$row->id))->assertJsonPath('data.status', 'suspended')
            ->assertJsonPath('data.can_recheck', false)->assertJsonPath('data.failure_code', 'suspended');
    }

    #[Group('tenancy')]
    #[Group('security')]
    public function test_cross_tenant_and_cross_store_ids_are_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->domainShop(slug: 'a');
        [, $tenantB, $storeB, $hB] = $this->domainShop(slug: 'b');
        $b = $this->addDomain($hB, $storeB, 'shop.b-example.com')->json('data.id');
        $bPlatform = $this->api($hB, 'GET', $this->domainsUrl($storeB))->json('data.0.id');

        // A's store with B's domain id, and B's store with A's headers.
        $requests = [];
        foreach ([$b, $bPlatform] as $id) {
            $requests[] = ['GET', $this->domainsUrl($storeA, '/'.$id)];
            $requests[] = ['POST', $this->domainsUrl($storeA, '/'.$id.'/verify')];
            $requests[] = ['POST', $this->domainsUrl($storeA, '/'.$id.'/primary')];
            $requests[] = ['DELETE', $this->domainsUrl($storeA, '/'.$id)];
            $requests[] = ['GET', $this->domainsUrl($storeB, '/'.$id)];
            $requests[] = ['DELETE', $this->domainsUrl($storeB, '/'.$id)];
        }
        $requests[] = ['GET', $this->domainsUrl($storeB)];
        $requests[] = ['POST', $this->domainsUrl($storeB), ['hostname' => 'x.acme.com']];
        $this->assertTenantIsolation($hA, $requests);

        $this->inTenant($tenantB, fn () => $this->assertSame(2, StoreDomain::query()->count()));
        $this->assertStoreIsolation(StoreDomain::class, $tenantA, $storeA, $storeB);
        $this->inTenant($tenantA, fn () => $this->assertNull(StoreDomain::query()->find($b)));
    }
}
