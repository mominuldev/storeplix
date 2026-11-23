<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Domains;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-1 §6.4 / §4.2: platform-wide custom domains; re-check / suspend / reinstate = the Phase 6 Actions. */
#[Group('admin')]
class AdminDomainsTest extends TestCase
{
    use DomainFixtures, PlatformStaffFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    /** @param array<string, mixed> $body */
    private function admin(User $as, string $method, string $uri, array $body = []): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($as))->json($method, '/api/v1/admin/'.$uri, $body);
    }

    public function test_list_filters_and_actions(): void
    {
        $sa = $this->staffUser(PlatformRole::SuperAdmin);
        $support = $this->staffUser(PlatformRole::Support);
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');

        $this->admin($support, 'GET', 'domains')->assertOk()->assertJsonPath('meta.total', 1) // custom rows only
            ->assertJsonPath('data.0.hostname', 'shop.acme.com')->assertJsonPath('data.0.kind', 'custom')
            ->assertJsonPath('data.0.dns_ok', true)->assertJsonPath('data.0.ssl_ok', true)->assertJsonPath('data.0.tenant.id', $tenant->id);
        $this->admin($support, 'GET', 'domains?filter[state]=suspended')->assertJsonPath('meta.total', 0);
        $this->admin($support, 'GET', 'domains?filter[q]=acme')->assertJsonPath('meta.total', 1);

        // re-check: support may, no merchant cooldown (6/min for merchants)
        for ($i = 0; $i < 8; $i++) {
            $this->admin($support, 'POST', "domains/{$row->id}/recheck")->assertStatus(202)->assertJsonPath('data.status', 'active');
        }
        $this->admin($this->staffUser(PlatformRole::Billing), 'POST', "domains/{$row->id}/recheck")->assertForbidden();

        // suspend / reinstate: super admin only, reason required
        $this->admin($support, 'POST', "domains/{$row->id}/suspend", ['reason' => 'Phishing report'])->assertForbidden();
        $this->admin($sa, 'POST', "domains/{$row->id}/suspend", [])->assertStatus(422);
        $this->admin($sa, 'POST', "domains/{$row->id}/suspend", ['reason' => 'Phishing report'])->assertOk()
            ->assertJsonPath('data.status', 'suspended')->assertJsonPath('data.failure_code', 'suspended');
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'domain.suspended')->sole();
        $this->assertSame(['platform_user', 'Phishing report'], [$audit->actor_type, $audit->meta['reason']]);
        $this->admin($sa, 'POST', "domains/{$row->id}/suspend", ['reason' => 'Phishing report'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->admin($support, 'POST', "domains/{$row->id}/recheck")->assertStatus(409);
        $this->admin($support, 'GET', 'domains?filter[state]=suspended')->assertJsonPath('meta.total', 1);

        $this->admin($sa, 'POST', "domains/{$row->id}/reinstate", ['reason' => 'Cleared after review'])->assertOk()->assertJsonPath('data.status', 'active');
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'domain.reinstated')->sole();
        $this->assertSame(['platform_user', 'Cleared after review', 'active'], [$audit->actor_type, $audit->meta['reason'], $audit->meta['status']]);
        $this->admin($sa, 'POST', "domains/{$row->id}/reinstate", ['reason' => 'Cleared after review'])->assertStatus(409);

        // the platform row is not part of the admin table
        $platform = $this->inTenant($tenant, fn () => StoreDomain::query()->where('type', StoreDomain::TYPE_PLATFORM)->value('id'));
        $this->admin($sa, 'POST', "domains/{$platform}/suspend", ['reason' => 'Phishing report'])->assertNotFound();
    }

    public function test_recheck_keeps_the_plan_gate(): void
    {
        $support = $this->staffUser(PlatformRole::Support);
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'gate.acme.com')->assertCreated()->json('data.id');
        $this->inTenant($tenant, fn () => StoreDomain::query()->whereKey($id)->update(['status' => StoreDomain::STATUS_EXPIRED]));
        $this->onPlan($tenant, 'free');

        $this->admin($support, 'POST', "domains/{$id}/recheck")->assertStatus(402);
        $this->assertSame(StoreDomain::STATUS_EXPIRED, $this->domainRow($tenant, $id)->status);
    }
}
