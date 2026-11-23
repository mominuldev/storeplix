<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Impersonation;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Routing\Route as RouteObject;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Fixtures\StrictCsrf;
use Tests\Support\BillingFixtures;
use Tests\Support\CatalogFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-1 P8-9 – P8-11, §3.2, §4.4, §6.5, §6.6; S71 – S74. Merchant-origin calls go through the simulated SPA browser
 * (cookie jar, strict CSRF, database sessions); admin-surface calls use an `admin` session on the web guard.
 */
#[Group('impersonation')]
#[Group('admin')]
class ImpersonationTest extends TestCase
{
    use BillingFixtures, CatalogFixtures, RefreshDatabase, SpaBrowser;

    private const REASON = 'Customer ticket: orders not showing';

    protected function setUp(): void
    {
        parent::setUp();
        $this->useSpaBrowser();
        Mail::fake();
    }

    // --- Admin side -------------------------------------------------------------------------------------------------

    public function test_admin_creates_a_single_use_ticket_url_and_only_impersonate_roles_may(): void
    {
        [, $tenant] = $this->shop();
        $support = $this->staff('support');

        $res = $this->admin($support, 'POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => self::REASON, 'ticket_ref' => 'ZD-42'])
            ->assertCreated()->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonStructure(['data' => ['id', 'url', 'ticket_expires_at']]);
        $prefix = rtrim((string) config('storeplix.merchant_app_url'), '/').'/impersonate#ticket=';
        $this->assertStringStartsWith($prefix, $res->json('data.url'));
        $ticket = Str::after($res->json('data.url'), '#ticket=');
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $ticket); // 32 bytes, base64url

        $row = PlatformImpersonation::query()->findOrFail($res->json('data.id'));
        $this->assertSame(hash('sha256', $ticket), $row->ticket_hash);
        $this->assertSame(PlatformImpersonation::PENDING, $row->status);
        $this->assertSame('ZD-42', $row->ticket_ref);
        $this->assertEqualsWithDelta(60, now()->diffInSeconds($row->ticket_expires_at), 2);
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'admin.impersonation%')->count(), 'audited on consume only');

        $this->admin($this->staff('super_admin'), 'POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => self::REASON])->assertCreated();
        foreach (['billing', 'read_only'] as $role) {
            $this->admin($this->staff($role), 'POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => self::REASON])
                ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        $this->admin($support, 'POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => 'abc'])
            ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->admin($support, 'POST', '/api/v1/admin/tenants/'.strtolower((string) Str::ulid()).'/impersonations', ['reason' => self::REASON])
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->admin($support, 'POST', '/api/v1/admin/tenants/nope/impersonations', ['reason' => self::REASON])->assertNotFound();
    }

    #[Group('security')]
    public function test_a_merchant_session_cannot_reach_the_admin_impersonation_routes(): void
    {
        [$owner, $tenant] = $this->shop();
        $owner->forceFill(['platform_role' => 'super_admin'])->save(); // even staff, on a merchant-surface session
        $this->spaLogin($owner);

        $this->b('POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => self::REASON])
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->b('GET', '/api/v1/admin/impersonations')->assertForbidden();
        $this->assertSame(0, PlatformImpersonation::query()->count());
    }

    public function test_admin_lists_sessions_with_filters(): void
    {
        [, $tenant, $store] = $this->shop();
        $staff = $this->staff();
        $id = $this->impersonate($staff, $tenant);
        $this->service()->create($staff, $tenant, self::REASON, null, null, null); // a pending one

        $res = $this->admin($this->staff('read_only'), 'GET', '/api/v1/admin/impersonations?filter[status]=active')->assertOk()
            ->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $id)
            ->assertJsonPath('data.0.staff.email', $staff->email)
            ->assertJsonPath('data.0.tenant', ['id' => $tenant->id, 'name' => $tenant->name, 'slug' => $store->slug])
            ->assertJsonPath('data.0.reason', self::REASON)->assertJsonPath('data.0.ticket_ref', 'ZD-1');
        $this->assertNotNull($res->json('data.0.started_at'));
        $this->assertArrayNotHasKey('ticket_hash', $res->json('data.0'));

        $this->admin($this->staff('read_only'), 'GET', "/api/v1/admin/impersonations?filter[tenant]={$tenant->id}")->assertOk()->assertJsonPath('meta.total', 2);
        $this->admin($this->staff('read_only'), 'GET', '/api/v1/admin/impersonations?filter[staff]='.strtolower((string) Str::ulid()))->assertOk()->assertJsonPath('meta.total', 0);
        $this->admin($this->staff('read_only'), 'GET', '/api/v1/admin/impersonations?filter[status]=bogus')->assertUnprocessable();
    }

    // --- Ticket lifecycle (S73) -------------------------------------------------------------------------------------

    #[Group('security')]
    public function test_ticket_is_single_use_short_lived_and_every_failure_is_the_same_404(): void
    {
        [, $tenant] = $this->shop();
        $staff = $this->staff();

        [$row, $url] = $this->service()->create($staff, $tenant, self::REASON, null, null, null);
        $ticket = Str::after($url, '#ticket=');
        $this->b('GET', '/sanctum/csrf-cookie');
        $ok = $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertOk();
        $this->assertSame($staff->id, $ok->json('data.user.id'));
        $this->assertSame($row->id, $ok->json('data.impersonation.id'));
        $row->refresh();
        $this->assertSame(PlatformImpersonation::ACTIVE, $row->status);
        $this->assertSame(15 * 60, (int) $row->started_at->diffInSeconds($row->expires_at));
        $this->assertSame($row->expires_at->toIso8601ZuluString(), $ok->json('data.session_expires_at'));

        $unknown = $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => Str::random(43)])->assertNotFound();
        $replay = $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertNotFound();
        $this->assertSame($unknown->json(), $replay->json());

        [$late, $lateUrl] = $this->service()->create($staff, $tenant, self::REASON, null, null, null);
        $this->travel(61)->seconds();
        $expired = $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($lateUrl, '#ticket=')])->assertNotFound();
        $this->assertSame($unknown->json(), $expired->json());
        $this->assertSame(PlatformImpersonation::EXPIRED, $late->refresh()->status);

        // The staff member lost `impersonate` between issue and consume.
        [, $demotedUrl] = $this->service()->create($staff, $tenant, self::REASON, null, null, null);
        $staff->forceFill(['platform_role' => 'read_only'])->save();
        $this->assertSame($unknown->json(), $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($demotedUrl, '#ticket=')])->assertNotFound()->json());

        $this->b('POST', '/api/v1/auth/impersonation', [])->assertUnprocessable();
    }

    #[Group('security')]
    public function test_consume_regenerates_the_session_and_replaces_a_merchant_session(): void
    {
        [$owner, $tenant] = $this->shop();
        $staff = $this->staff();
        $this->spaLogin($owner);
        $this->b('GET', '/api/v1/auth/me')->assertOk()->assertJsonPath('data.id', $owner->id)->assertJsonPath('meta.impersonation', null);
        $ownerJar = $this->jar;

        [, $url] = $this->service()->create($staff, $tenant, self::REASON, null, null, null);
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $this->assertNotSame($ownerJar[config('session.cookie')], $this->jar[config('session.cookie')]);
        $this->assertNotSame($ownerJar['XSRF-TOKEN'], $this->jar['XSRF-TOKEN']);
        $this->b('GET', '/api/v1/auth/me')->assertOk()->assertJsonPath('data.id', $staff->id);

        $this->jar = $ownerJar; // the old session id is dead
        $this->b('GET', '/api/v1/auth/me')->assertUnauthorized();
    }

    #[Group('security')]
    public function test_consume_needs_csrf_and_honours_the_ip_allowlist_and_its_rate_limit(): void
    {
        [, $tenant] = $this->shop();
        $staff = $this->staff();
        [, $url] = $this->service()->create($staff, $tenant, self::REASON, null, null, null);
        $ticket = Str::after($url, '#ticket=');
        $this->b('GET', '/sanctum/csrf-cookie');

        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket], csrf: false)->assertStatus(419);
        $this->flushHeaders()->withHeaders(['Origin' => 'https://script.test'])->postJson('/api/v1/auth/impersonation', ['ticket' => $ticket])
            ->assertStatus(400)->assertJsonPath('error.code', 'stateful_required');

        config(['admin.ip_allowlist' => ['10.0.0.0/8']]);
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->assertSame(PlatformImpersonation::PENDING, PlatformImpersonation::query()->sole()->status);
        config(['admin.ip_allowlist' => []]);

        for ($i = 0; $i < 10; $i++) {
            $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => 'wrong-'.$i])->assertNotFound();
        }
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
    }

    // --- /auth/me and scope (S72) -----------------------------------------------------------------------------------

    #[Group('security')]
    public function test_me_shows_the_staff_user_with_only_the_impersonated_tenant_and_other_tenants_are_refused(): void
    {
        [$owner, $tenant] = $this->shop();
        $staff = $this->staff();
        $own = Tenant::factory()->create(); // the staff member also owns a shop
        $this->inTenant($own, fn () => TenantUser::query()->create(['tenant_id' => $own->id, 'user_id' => $staff->id, 'role' => TenantUser::ROLE_OWNER]));
        $this->storeFor($own, 'staffshop');
        $id = $this->impersonate($staff, $tenant);
        $row = PlatformImpersonation::query()->findOrFail($id);

        $this->b('GET', '/api/v1/auth/me')->assertOk()
            ->assertJsonPath('data.id', $staff->id)->assertJsonPath('data.email', $staff->email)
            ->assertJsonPath('data.tenants', [[
                'id' => $tenant->id, 'name' => $tenant->name, 'role' => 'owner',
                // PHASE-8-3 §6.2: impersonation = the owner set
                'role_id' => $this->platformTable('roles')->where('tenant_id', $tenant->id)->where('key', 'owner')->value('id'),
                'role_name' => 'Owner', 'permissions' => SystemRole::Owner->permissions()->keys(),
            ]])
            ->assertJsonPath('meta.impersonation', [
                'id' => $id, 'tenant_id' => $tenant->id, 'tenant_name' => $tenant->name, 'owner_name' => $owner->name,
                'reason' => self::REASON, 'expires_at' => $row->expires_at->toIso8601ZuluString(),
            ])
            ->assertJsonPath('meta.session_expires_at', $row->expires_at->toIso8601ZuluString());

        $this->b('GET', '/api/v1/stores', headers: ['X-Tenant-Id' => $tenant->id])->assertOk()->assertJsonCount(1, 'data');
        $this->b('GET', '/api/v1/stores', headers: ['X-Tenant-Id' => $own->id])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->b('GET', '/api/v1/stores', headers: ['X-Tenant-Id' => strtolower((string) Str::ulid())])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->b('GET', '/api/v1/stores')->assertStatus(400)->assertJsonPath('error.code', 'tenant_required');
    }

    public function test_owner_level_reads_work_and_a_suspended_tenant_stays_viewable(): void
    {
        [$owner, $tenant, $store] = $this->shop();
        $staff = $this->staff();
        $tenant->forceFill(['status' => Tenant::STATUS_SUSPENDED])->save();
        $this->getJson('/api/v1/stores', $this->tenantHeaders($owner, $tenant))->assertForbidden(); // the merchant is refused

        $this->impersonate($staff, $tenant);
        $h = ['X-Tenant-Id' => $tenant->id];
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: $h)->assertOk()->assertJsonPath('data.id', $store->id);
        $this->b('GET', "/api/v1/stores/{$store->id}/products", headers: $h)->assertOk();
        $this->b('GET', "/api/v1/stores/{$store->id}/orders", headers: $h)->assertOk();
        $this->b('GET', '/api/v1/billing/invoices', headers: $h)->assertOk(); // owner-only read (billing.view)
        $this->b('GET', '/api/v1/staff', headers: $h)->assertOk();
        $this->b('GET', '/api/v1/audit-logs', headers: $h)->assertOk();
    }

    // --- Read-only (S71) --------------------------------------------------------------------------------------------

    #[Group('security')]
    public function test_every_non_get_merchant_route_is_refused_with_no_database_change(): void
    {
        [, $tenant, $store] = $this->shop();
        $this->impersonate($this->staff(), $tenant);
        $before = $this->snapshot();

        $checked = 0;
        $failures = [];
        foreach (Route::getRoutes()->getRoutes() as $route) {
            if (! $this->isMerchantRoute($route)) {
                continue;
            }
            foreach (array_diff($route->methods(), ['GET', 'HEAD', 'OPTIONS']) as $method) {
                $url = '/'.preg_replace_callback('/\{(\w+)\??\}/', fn (array $m) => $this->param($route, $m[1], $store), $route->uri());
                app('cache')->store()->flush(); // rate limiters never answer first
                $res = $this->b($method, $url, [], ['X-Tenant-Id' => $tenant->id]);
                if ($res->status() !== 403 || $res->json('error.code') !== 'impersonation_read_only') {
                    $failures[] = "{$method} {$route->uri()} → {$res->status()} ".(string) $res->json('error.code');
                }
                $checked++;
            }
        }

        $this->assertSame([], $failures);
        $this->assertGreaterThan(100, $checked, 'the dataset comes from the live route list');
        $this->assertSame($before, $this->snapshot(), 'no row changed (incl. request_count and audit_logs)');
        $this->b('GET', '/api/v1/auth/me')->assertOk()->assertJsonPath('meta.impersonation.tenant_id', $tenant->id);
    }

    #[Group('security')]
    public function test_dev_routes_and_the_billing_payment_provider_query_are_blocked(): void
    {
        [$owner, $tenant] = $this->shop();
        $h = $this->tenantHeaders($owner, $tenant);
        $invoice = $this->changePlan($h, 'starter')->assertCreated()->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice)->assertCreated()->json('data.id');

        $this->impersonate($this->staff(), $tenant);
        $this->b('POST', '/api/v1/dev/billing/clock', ['days' => 1], ['X-Tenant-Id' => $tenant->id])
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');

        $this->travel(30)->seconds();
        $this->b('GET', "/api/v1/billing/payments/{$payment}", headers: ['X-Tenant-Id' => $tenant->id])->assertOk()->assertJsonPath('data.id', $payment);
        $this->assertNull($this->inTenant($tenant, fn () => BillingPayment::query()->findOrFail($payment)->last_queried_at), 'no provider query');

        $this->flushHeaders()->getJson("/api/v1/billing/payments/{$payment}", $h)->assertOk(); // control: the owner's read does query
        $this->assertNotNull($this->inTenant($tenant, fn () => BillingPayment::query()->findOrFail($payment)->last_queried_at));
    }

    // --- Counter, audit, end (P8-11) --------------------------------------------------------------------------------

    public function test_reads_bump_the_counter_and_start_and_end_are_audited_on_the_tenant(): void
    {
        [, $tenant, $store] = $this->shop();
        $staff = $this->staff();
        $id = $this->impersonate($staff, $tenant);

        $started = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_started')->sole();
        $this->assertSame('platform_user', $started->actor_type);
        $this->assertSame($staff->id, $started->actor_id);
        $this->assertSame($id, $started->subject_id);
        $this->assertSame(self::REASON, $started->meta['reason']);
        $this->assertSame('ZD-1', $started->meta['ticket_ref']);
        $this->assertSame($id, $started->meta['impersonation_id']);
        $this->assertSame('support', $started->meta['platform_role']);
        $this->assertNotNull($started->meta['expires_at']);

        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])->assertOk();
        $this->b('GET', "/api/v1/stores/{$store->id}/products", headers: ['X-Tenant-Id' => $tenant->id])->assertOk();
        $row = PlatformImpersonation::query()->findOrFail($id);
        $this->assertSame(2, $row->request_count);
        $this->assertNotNull($row->last_request_at);

        $this->b('DELETE', '/api/v1/auth/impersonation')->assertNoContent();
        $row->refresh();
        $this->assertSame([PlatformImpersonation::ENDED, PlatformImpersonation::ENDED_BY_STAFF], [$row->status, $row->ended_by]);
        $ended = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_ended')->sole();
        $this->assertSame('platform_user', $ended->actor_type);
        $this->assertSame($staff->id, $ended->actor_id);
        $this->assertSame(['staff', 2], [$ended->meta['ended_by'], $ended->meta['request_count']]);
        $this->b('GET', '/api/v1/auth/me')->assertUnauthorized();
    }

    public function test_logout_ends_the_impersonation_as_staff(): void
    {
        [, $tenant] = $this->shop();
        $id = $this->impersonate($this->staff(), $tenant);
        $this->b('POST', '/api/v1/auth/logout')->assertNoContent();
        $this->assertSame(PlatformImpersonation::ENDED_BY_STAFF, PlatformImpersonation::query()->findOrFail($id)->ended_by);
        $this->b('GET', '/api/v1/auth/me')->assertUnauthorized();
    }

    public function test_delete_outside_an_impersonation_session_is_404_and_keeps_the_session(): void
    {
        [$owner] = $this->shop();
        $this->spaLogin($owner);
        $this->b('DELETE', '/api/v1/auth/impersonation')->assertNotFound();
        $this->b('GET', '/api/v1/auth/me')->assertOk()->assertJsonPath('data.id', $owner->id);
    }

    // --- Expiry, revoke, disabled staff (S74) -----------------------------------------------------------------------

    #[Group('security')]
    public function test_the_session_ends_after_fifteen_minutes(): void
    {
        [, $tenant, $store] = $this->shop();
        $id = $this->impersonate($this->staff(), $tenant);
        $this->travel(14)->minutes();
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])->assertOk();

        $this->travel(2)->minutes();
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])
            ->assertUnauthorized()->assertJsonPath('error.code', 'impersonation_ended');
        $row = PlatformImpersonation::query()->findOrFail($id);
        $this->assertSame([PlatformImpersonation::ENDED, PlatformImpersonation::ENDED_BY_EXPIRY], [$row->status, $row->ended_by]);
        $ended = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_ended')->sole();
        $this->assertSame('system', $ended->actor_type);
        $this->assertSame(1, $ended->meta['request_count']);
        $this->b('GET', '/api/v1/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated'); // session gone
    }

    public function test_me_after_expiry_answers_impersonation_ended(): void
    {
        [, $tenant] = $this->shop();
        $this->impersonate($this->staff(), $tenant);
        $this->travel(16)->minutes();
        $this->b('GET', '/api/v1/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'impersonation_ended');
    }

    #[Group('security')]
    public function test_revoke_ends_the_session_at_its_next_request(): void
    {
        [, $tenant, $store] = $this->shop();
        $id = $this->impersonate($this->staff(), $tenant);
        $sa = $this->staff('super_admin');

        $this->admin($this->staff('support'), 'POST', "/api/v1/admin/impersonations/{$id}/revoke", ['reason' => 'Ticket closed'])->assertForbidden();
        $this->admin($sa, 'POST', "/api/v1/admin/impersonations/{$id}/revoke", [])->assertUnprocessable();
        $this->admin($sa, 'POST', "/api/v1/admin/impersonations/{$id}/revoke", ['reason' => 'Ticket closed'])->assertOk()
            ->assertJsonPath('data.status', 'ended')->assertJsonPath('data.ended_by', 'revoked');
        $ended = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_ended')->sole();
        $this->assertSame([$sa->id, 'platform_user', 'Ticket closed'], [$ended->actor_id, $ended->actor_type, $ended->meta['reason']]);

        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])
            ->assertUnauthorized()->assertJsonPath('error.code', 'impersonation_ended');
        $this->admin($sa, 'POST', "/api/v1/admin/impersonations/{$id}/revoke", ['reason' => 'Ticket closed'])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->admin($sa, 'POST', '/api/v1/admin/impersonations/'.strtolower((string) Str::ulid()).'/revoke', ['reason' => 'Ticket closed'])->assertNotFound();
    }

    #[Group('security')]
    public function test_disabling_the_staff_member_ends_their_impersonations(): void
    {
        [, $tenant, $store] = $this->shop();
        $staff = $this->staff();
        $id = $this->impersonate($staff, $tenant);
        $pending = $this->service()->create($staff, $tenant, self::REASON, null, null, null)[0];

        $this->assertSame(1, $this->service()->endAllForStaff($staff, PlatformImpersonation::ENDED_BY_REVOKED));
        $this->assertSame(PlatformImpersonation::ENDED_BY_REVOKED, PlatformImpersonation::query()->findOrFail($id)->ended_by);
        $this->assertSame(PlatformImpersonation::EXPIRED, $pending->refresh()->status);
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])
            ->assertUnauthorized()->assertJsonPath('error.code', 'impersonation_ended');

        // Disabled without the team action: the next request notices it.
        $other = $this->staff();
        $this->jar = [];
        $second = $this->impersonate($other, $tenant);
        $other->forceFill(['platform_disabled_at' => now()])->save();
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])
            ->assertUnauthorized()->assertJsonPath('error.code', 'impersonation_ended');
        $this->assertSame(PlatformImpersonation::ENDED_BY_REVOKED, PlatformImpersonation::query()->findOrFail($second)->ended_by);
    }

    public function test_close_command_ends_overdue_sessions_and_expires_unused_tickets(): void
    {
        [, $tenant] = $this->shop();
        $staff = $this->staff();
        $active = $this->impersonate($staff, $tenant);
        $pending = $this->service()->create($staff, $tenant, self::REASON, null, null, null)[0];
        $fresh = null;

        $this->travel(16)->minutes();
        $fresh = $this->service()->create($staff, $tenant, self::REASON, null, null, null)[0];
        $this->artisan('admin:close-impersonations')->assertSuccessful();

        $row = PlatformImpersonation::query()->findOrFail($active);
        $this->assertSame([PlatformImpersonation::ENDED, PlatformImpersonation::ENDED_BY_EXPIRY], [$row->status, $row->ended_by]);
        $this->assertSame(PlatformImpersonation::EXPIRED, $pending->refresh()->status);
        $this->assertSame(PlatformImpersonation::PENDING, $fresh->refresh()->status);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_ended')->count());
        $this->artisan('admin:close-impersonations')->assertSuccessful(); // idempotent
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'admin.impersonation_ended')->count());
    }

    #[Group('security')]
    public function test_the_ticket_never_reaches_a_log_line_or_the_database(): void
    {
        $lines = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$lines): void {
            $lines[] = $e->message.' '.json_encode($e->context);
        });
        [, $tenant, $store] = $this->shop();
        $staff = $this->staff();

        $url = $this->admin($staff, 'POST', "/api/v1/admin/tenants/{$tenant->id}/impersonations", ['reason' => self::REASON])->assertCreated()->json('data.url');
        $ticket = Str::after($url, '#ticket=');
        $this->b('GET', '/sanctum/csrf-cookie');
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertOk();
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => $ticket])->assertNotFound();
        $this->b('GET', "/api/v1/stores/{$store->id}", headers: ['X-Tenant-Id' => $tenant->id])->assertOk();
        $this->b('DELETE', '/api/v1/auth/impersonation')->assertNoContent();
        logger()->info('probe'); // the capture works

        $this->assertNotEmpty($lines);
        foreach ($lines as $line) {
            $this->assertStringNotContainsString($ticket, $line);
        }
        foreach ($this->snapshotRows() as $table => $json) {
            $this->assertStringNotContainsString($ticket, $json, "ticket stored in {$table}");
        }
    }

    // --- helpers ----------------------------------------------------------------------------------------------------

    private function service(): ImpersonationService
    {
        return app(ImpersonationService::class);
    }

    private function staff(string $role = 'support'): User
    {
        $user = User::factory()->create();
        $user->forceFill(['platform_role' => $role])->save();

        return $user;
    }

    /** Issues a ticket and consumes it in the SPA browser. Returns the impersonation id. */
    private function impersonate(User $staff, Tenant $tenant): string
    {
        [$row, $url] = $this->service()->create($staff, $tenant, self::REASON, 'ZD-1', '127.0.0.1', 'phpunit');
        $this->b('GET', '/sanctum/csrf-cookie');
        $this->b('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();

        return $row->id;
    }

    /**
     * SPA-browser request with exactly the jar's cookies.
     *
     * @param  array<string, mixed>  $data
     * @param  array<string, string>  $headers
     */
    private function b(string $method, string $uri, array $data = [], array $headers = [], bool $csrf = true): TestResponse
    {
        $this->unencryptedCookies = [];

        return $this->browser($method, $uri, $data, $headers, $csrf);
    }

    /**
     * An `admin`-surface session for $staff (the admin sign-in itself is AdminLoginTest's job).
     *
     * @param  array<string, mixed>  $data
     */
    private function admin(User $staff, string $method, string $uri, array $data = []): TestResponse
    {
        config(['sanctum.middleware.validate_csrf_token' => ValidateCsrfToken::class]);
        $this->unencryptedCookies = [];
        $this->freshSession();
        try {
            return $this->flushHeaders()->withSession([SessionSurface::KEY => SessionSurface::ADMIN])
                ->withHeaders(['X-Testing-User' => $staff->id, 'Referer' => 'http://localhost:5174/', 'Accept' => 'application/json'])
                ->json($method, $uri, $data);
        } finally {
            config(['sanctum.middleware.validate_csrf_token' => StrictCsrf::class]);
            $this->freshSession();
            $this->app['auth']->forgetGuards();
        }
    }

    /** Merchant-origin routes: api/v1 minus admin, storefront, dev, public callbacks/webhooks and the session exits. */
    private function isMerchantRoute(RouteObject $route): bool
    {
        $uri = $route->uri();
        if (! str_starts_with($uri, 'api/v1/')) {
            return false;
        }
        $path = substr($uri, strlen('api/v1/'));
        if (preg_match('#^(admin|storefront|dev|webhooks)/|^(billing/)?payments/return/|^billing/webhooks/#', $path) === 1) {
            return false;
        }

        return ! in_array($route->getName(), ['auth.logout', 'auth.impersonation.store', 'auth.impersonation.destroy'], true);
    }

    private function param(RouteObject $route, string $name, Store $store): string
    {
        if ($name === 'store') {
            return $store->id;
        }
        $where = $route->wheres[$name] ?? null;
        if (is_string($where) && preg_match('/^[a-z0-9_]+(\|[a-z0-9_]+)+$/', $where) === 1) {
            return explode('|', $where)[0];
        }
        if ($where === '[A-Za-z0-9]{32}') {
            return Str::random(32);
        }

        return strtolower((string) Str::ulid());
    }

    /** @return array<string, string> table → md5 of every row (sessions, cache and the queue excluded) */
    private function snapshot(): array
    {
        return array_map('md5', $this->snapshotRows());
    }

    /** @return array<string, string> */
    private function snapshotRows(): array
    {
        $skip = ['sessions', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs', 'migrations'];
        $rows = [];
        foreach (Schema::getTables() as $table) {
            $name = (string) $table['name'];
            if (! in_array($name, $skip, true) && ! str_starts_with($name, 'sqlite_')) {
                $rows[$name] = (string) json_encode($this->platformTable($name)->get());
            }
        }
        ksort($rows);

        return $rows;
    }
}
