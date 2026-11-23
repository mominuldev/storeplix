<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Permissions;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Session\ArraySessionHandler;
use Illuminate\Session\Store;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-1 P8-8, S81: the platform actor on audit rows and how merchants see it. */
#[Group('admin')]
#[Group('security')]
class MerchantAuditActorTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase;

    private function requestOn(string $surface, mixed $user): Request
    {
        $request = Request::create('/api/v1/anything', 'POST', server: ['REMOTE_ADDR' => '203.0.113.9', 'HTTP_USER_AGENT' => 'StaffBrowser/1.0']);
        $session = new Store('test', new ArraySessionHandler(10));
        $session->put(SessionSurface::KEY, $surface);
        $request->setLaravelSession($session);
        $request->setUserResolver(fn () => $user);

        return $request;
    }

    public function test_platform_actor_is_inferred_from_the_admin_and_impersonation_surfaces(): void
    {
        $staff = $this->staffUser(PlatformRole::Support);
        [$merchant] = $this->merchant();
        $context = app(TenantContext::class);

        foreach ([SessionSurface::ADMIN => 'platform_user', SessionSurface::IMPERSONATION => 'platform_user', SessionSurface::MERCHANT => 'user'] as $surface => $type) {
            $row = (new AuditLogger($context, $this->requestOn($surface, $staff)))->log('test.surface_'.$surface, tenantId: false);
            $this->assertSame($type, $row->actor_type, $surface);
            $this->assertSame($staff->id, $row->actor_id);
            $this->assertSame($type === 'platform_user' ? ['platform_role' => 'support'] : null, $row->meta);
        }

        // An explicit actor other than the signed-in staff member is a plain user.
        $row = (new AuditLogger($context, $this->requestOn(SessionSurface::ADMIN, $staff)))->log('test.other_actor', actor: $merchant, tenantId: false);
        $this->assertSame('user', $row->actor_type);
        // Explicit flag; system rows stay system.
        $row = (new AuditLogger($context, null))->log('test.explicit', actor: $staff, tenantId: false, platform: true);
        $this->assertSame('platform_user', $row->actor_type);
        $row = (new AuditLogger($context, $this->requestOn(SessionSurface::ADMIN, $staff)))->log('test.system', tenantId: false, system: true);
        $this->assertSame('system', $row->actor_type);
        $this->assertNull($row->actor_id);
    }

    /** S81: merchant GET /audit-logs for an admin action has no staff name, email, id, IP, user agent or role. */
    public function test_merchants_see_store_plix_support_and_nothing_about_the_staff_member(): void
    {
        $staff = $this->staffUser(PlatformRole::Billing, ['name' => 'Secret Staffer', 'email' => 'secret.staffer@storeplix.com']);
        [$owner, $tenant] = $this->merchant();
        $this->inTenant($tenant, fn () => (new AuditLogger(app(TenantContext::class), $this->requestOn(SessionSurface::ADMIN, $staff)))
            ->log('subscription.extended', $tenant, ['days' => 7, 'reason' => 'Goodwill after outage']));
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'subscription.extended')->where('actor_type', 'platform_user')->count());

        $response = $this->withHeaders($this->tenantHeaders($owner, $tenant))->getJson('/api/v1/audit-logs?filter[action]=subscription.extended')
            ->assertOk()
            ->assertJsonPath('data.0.actor', ['type' => 'platform_user', 'id' => null, 'name' => 'Store Plix support'])
            ->assertJsonPath('data.0.meta', ['days' => 7, 'reason' => 'Goodwill after outage'])
            ->assertJsonPath('data.0.ip', null)
            ->assertJsonPath('data.0.user_agent', null);
        $body = (string) $response->getContent();
        foreach ([$staff->id, 'Secret Staffer', 'secret.staffer', '203.0.113.9', 'StaffBrowser', 'billing'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }

        // Staff ids can't be probed through the actor filter either.
        $this->withHeaders($this->tenantHeaders($owner, $tenant))->getJson('/api/v1/audit-logs?filter[actor_id]='.$staff->id)
            ->assertOk()->assertJsonPath('meta.total', 0);
    }
}
