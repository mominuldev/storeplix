<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Merchants;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-1 §6.2 – §6.5 admin reads (P8-6, P8-17, P8-18, S77). */
#[Group('admin')]
class AdminReadsTest extends TestCase
{
    use BillingFixtures, PlatformStaffFixtures, RefreshDatabase;

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        $this->staff = $this->staffUser(PlatformRole::ReadOnly);
    }

    private function admin(string $uri): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($this->staff))->getJson('/api/v1/admin/'.$uri);
    }

    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} */
    private function namedShop(string $slug, string $phone): array
    {
        [$user, $tenant, $store, $h] = $this->shop(slug: $slug);
        $user->forceFill(['phone' => $phone, 'email' => "{$slug}-owner@example.test"])->save();
        $tenant->forceFill(['name' => ucfirst($slug).' Tenant'])->save();

        return [$user, $tenant, $store, $h];
    }

    public function test_tenants_list_filters_tab_counts_sort_and_pagination(): void
    {
        [, $alpha] = $this->namedShop('alpha', '8801711222333');
        [, $bravo, $bravoStore] = $this->namedShop('bravo', '8801899000111');
        $this->onPlan($bravo, 'starter'); // active, paid → "paying"

        $all = $this->admin('tenants')->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('meta.total', 2)
            ->assertJsonPath('meta.counts', ['all' => 2, 'paying' => 1, 'trial' => 1, 'past_due' => 0, 'suspended' => 0]);
        $this->assertSame([$bravo->id, $alpha->id], array_column($all->json('data'), 'id')); // -created_at default

        $this->admin('tenants?filter[status]=paying')->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $bravo->id)
            ->assertJsonPath('data.0.plan_code', 'starter')->assertJsonPath('data.0.subscription_status', 'active')
            ->assertJsonPath('data.0.store.slug', $bravoStore->slug)->assertJsonPath('data.0.store.primary_host', $bravoStore->slug.'.storeplix.test')
            ->assertJsonPath('data.0.owner.email', 'bravo-owner@example.test');
        $this->admin('tenants?filter[status]=trial')->assertJsonPath('data.0.id', $alpha->id);
        $this->admin('tenants?filter[plan]=starter')->assertJsonPath('meta.total', 2); // the trial runs on Starter
        $this->admin('tenants?filter[plan]=growth')->assertJsonPath('meta.total', 0);

        // search: slug, owner e-mail prefix, owner phone (+88 stripped, punctuation ignored), hostname
        foreach (['alph', 'alpha-owner@', '+880 1711-222', '01711222', 'alpha'] as $q) {
            $this->admin('tenants?filter[q]='.urlencode($q))->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $alpha->id);
        }
        $this->admin('tenants?sort=name&per_page=1')->assertJsonPath('meta.last_page', 2)->assertJsonPath('data.0.id', $alpha->id);
        $this->admin('tenants?filter[status]=nope')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->admin('tenants?per_page=101')->assertStatus(422);
    }

    public function test_tenant_detail_members_domains_invoices_and_unknown_ids(): void
    {
        [$owner, $tenant, $store, $h] = $this->namedShop('detail', '8801711000000');
        [$member] = $this->member($tenant, 'staff');
        $invoice = $this->changePlan($h, 'starter')->assertCreated()->json('data.invoice');

        $this->admin("tenants/{$tenant->id}")->assertOk()
            ->assertJsonPath('data.id', $tenant->id)->assertJsonPath('data.status', 'active')->assertJsonPath('data.suspension', null)
            ->assertJsonPath('data.subscription.status', 'trialing')->assertJsonPath('data.member_count', 2)
            ->assertJsonPath('data.domain_count', 0)->assertJsonPath('data.lifetime_paid_amount', 0)
            ->assertJsonPath('data.open_invoice.number', $invoice['number'])
            ->assertJsonPath('data.open_invoice.tenant', ['id' => $tenant->id, 'name' => $store->name, 'slug' => $store->slug])
            ->assertJsonFragment(['key' => 'products', 'used' => 0]);

        $members = $this->admin("tenants/{$tenant->id}/members")->assertOk()->json('data');
        $this->assertSame([$owner->id, $member->id], array_column($members, 'id'));
        $this->assertSame('owner', $members[0]['role']);

        $this->admin("tenants/{$tenant->id}/domains")->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.hostname', $store->slug.'.storeplix.test')->assertJsonPath('data.0.kind', 'platform')
            ->assertJsonPath('data.0.dns_ok', true)->assertJsonPath('data.0.tenant.id', $tenant->id);

        $this->admin("tenants/{$tenant->id}/invoices")->assertOk()->assertJsonPath('meta.total', 1)
            ->assertJsonPath('data.0.id', $invoice['id'])->assertJsonPath('data.0.plan_code', 'starter')->assertJsonPath('data.0.provider', null);
        $this->admin("tenants/{$tenant->id}/invoices?filter[status]=paid")->assertJsonPath('meta.total', 0);

        $this->admin("invoices/{$invoice['id']}")->assertOk()->assertJsonPath('data.number', $invoice['number'])
            ->assertJsonPath('data.tenant.slug', $store->slug)->assertJsonPath('data.payments', []);
        $this->admin('invoices?filter[q]='.urlencode($invoice['number']))->assertJsonPath('meta.total', 1);
        $this->admin('invoices?filter[q]=detail&filter[status]=open')->assertJsonPath('meta.total', 1);

        $unknown = strtolower((string) Str::ulid());
        foreach (["tenants/{$unknown}", "tenants/{$unknown}/members", "tenants/{$unknown}/invoices", 'tenants/not-a-ulid', "invoices/{$unknown}"] as $uri) {
            $this->admin($uri)->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    public function test_global_search_matching_rules(): void
    {
        [, $tenant, $store, $h] = $this->namedShop('searchy', '8801755443322');
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice');

        $this->admin('search?q=x')->assertStatus(422);
        $this->admin('search?q=searchy')->assertOk()->assertJsonPath('data.tenants.0.id', $tenant->id)
            ->assertJsonPath('data.domains.0.hostname', $store->slug.'.storeplix.test');
        $this->admin('search?q='.$tenant->id)->assertJsonPath('data.tenants.0.id', $tenant->id);
        $this->admin('search?q=01755443322')->assertJsonPath('data.tenants.0.id', $tenant->id);
        $this->admin('search?q='.strtolower($invoice['number']))->assertJsonPath('data.invoices.0.id', $invoice['id']);
        $this->admin('search?q='.strtoupper($store->slug).'.storeplix.test')->assertJsonPath('data.domains.0.tenant.id', $tenant->id);
        $this->admin('search?q=nothing-matches-this')->assertExactJson(['data' => ['tenants' => [], 'domains' => [], 'invoices' => []]]);
    }

    public function test_overview_counts(): void
    {
        [, $a] = $this->namedShop('ov-a', '8801700000001');
        [, $b] = $this->namedShop('ov-b', '8801700000002');
        $this->onPlan($b, 'growth');

        $this->admin('overview')->assertOk()
            ->assertJsonPath('data.tenants', ['total' => 2, 'active' => 2, 'suspended' => 0])
            ->assertJsonPath('data.subscriptions.paying', 1)->assertJsonPath('data.subscriptions.trialing', 1)
            ->assertJsonPath('data.past_due', ['count' => 0, 'amount' => 0, 'currency' => 'BDT'])
            ->assertJsonPath('data.active_impersonations', 0)
            ->assertJsonPath('data.newest_tenants.0.id', $b->id)->assertJsonPath('data.newest_tenants.1.id', $a->id);
    }

    public function test_audit_log_filters_and_cursor_pagination(): void
    {
        [, $tenant, $store] = $this->namedShop('audited', '8801700000003');
        $this->inTenant($tenant, function () {
            foreach (['billing.one', 'billing.two', 'zzops.three'] as $action) {
                app(AuditLogger::class)->log($action, meta: ['reason' => 'because'], system: true);
            }
        });

        $first = $this->admin("audit-logs?filter[tenant]={$tenant->id}&filter[action]=billing.&per_page=1")->assertOk()
            ->assertJsonPath('data.0.action', 'billing.two')->assertJsonPath('data.0.reason', 'because')
            ->assertJsonPath('data.0.tenant.slug', $store->slug)->assertJsonPath('data.0.actor.type', 'system');
        $cursor = $first->json('meta.next_cursor');
        $this->assertNotNull($cursor);
        $this->admin("audit-logs?filter[tenant]={$tenant->id}&filter[action]=billing.&per_page=1&cursor={$cursor}")
            ->assertJsonPath('data.0.action', 'billing.one')->assertJsonPath('meta.next_cursor', null);
        $this->admin("tenants/{$tenant->id}/audit-logs?filter[actor_type]=system&filter[action]=zzops.")->assertJsonCount(1, 'data');
        $this->admin("tenants/{$tenant->id}/audit-logs?filter[impersonation]=1")->assertJsonCount(0, 'data');
    }

    #[Group('rls')]
    #[Group('security')]
    public function test_admin_reads_run_on_the_admin_connection_and_see_every_tenant_under_rls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        [, $a] = $this->namedShop('rls-a', '8801700000004');
        [, $b, $bStore] = $this->namedShop('rls-b', '8801700000005');

        $admin = DB::connection((string) config('tenancy.admin_connection'));
        $admin->flushQueryLog();
        $admin->enableQueryLog();
        DB::connection()->flushQueryLog();
        DB::connection()->enableQueryLog();

        $ids = array_column($this->admin('tenants')->assertOk()->json('data'), 'id');
        $this->assertEqualsCanonicalizing([$a->id, $b->id], $ids);

        $adminSql = implode("\n", array_column($admin->getQueryLog(), 'query'));
        $this->assertStringContainsString('"tenants"', $adminSql);
        $this->assertStringContainsString('"subscriptions"', $adminSql);
        $appSql = implode("\n", array_column(DB::connection()->getQueryLog(), 'query'));
        $this->assertStringNotContainsString('"subscriptions"', $appSql, 'cross-tenant reads must not run on the app connection');

        $this->admin('overview')->assertOk()->assertJsonPath('data.tenants.total', 2);
        $this->admin("tenants/{$b->id}")->assertOk()->assertJsonPath('data.store.slug', $bStore->slug);
    }
}
