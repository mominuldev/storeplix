<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Billing\Models\Subscription;
use App\Domain\Cart\Models\Cart;
use App\Domain\Identity\Models\User;
use App\Domain\Staff\Mail\StaffInvitationMail;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * §2.4: every pre-tenant / cross-tenant path works with RLS on, through its explicit bypass (definer function,
 * app.user_id, TenantContext::run, or pgsql_admin for console code), and nothing else needs one.
 */
#[Group('rls')]
#[Group('tenancy')]
class RlsBypassPathsTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    /** B3 + B2: registration writes the owner membership inside the new tenant; /auth/me lists memberships by user. */
    public function test_registration_and_auth_me_work_before_any_tenant_is_selected(): void
    {
        $this->postJson('/api/v1/auth/register', [
            'name' => 'Rls Owner', 'email' => 'rls-owner@example.com', 'password' => 'secret-pass1',
            'password_confirmation' => 'secret-pass1', 'phone' => '01711-222333',
        ])->assertCreated()->assertJsonPath('data.user.tenants.0.role', 'owner');

        $user = User::query()->where('email', 'rls-owner@example.com')->sole();
        $tenantId = $this->platformQuery(TenantUser::class)->where('user_id', $user->id)->value('tenant_id');
        $this->assertNotNull($tenantId);
        $this->assertSame(1, $this->platformQuery(Subscription::class)->where('tenant_id', $tenantId)->count());
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'auth.registered')->where('tenant_id', $tenantId)->exists());

        // B2: a member of two tenants sees both memberships with no X-Tenant-Id (app.user_id policy)
        [, $other] = $this->merchant();
        $this->inTenant($other, fn () => TenantUser::query()->create(['tenant_id' => $other->id, 'user_id' => $user->id, 'role' => 'staff']));
        $this->flushHeaders()->withHeaders(['X-Testing-User' => $user->id])->getJson('/api/v1/auth/me')
            ->assertOk()->assertJsonCount(2, 'data.tenants');
        // ...and ResolveTenant finds the membership of the selected tenant
        $this->flushHeaders()->withHeaders($this->tenantHeaders($user, $other))->getJson('/api/v1/stores')->assertOk();
    }

    /** B4: invitation show + accept resolve the tenant by token, then run inside it. */
    public function test_invitation_show_and_accept(): void
    {
        Mail::fake();
        [$owner, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'rls-invite');
        $this->flushHeaders()->withHeaders($this->tenantHeaders($owner, $tenant))
            ->postJson('/api/v1/staff/invitations', ['email' => 'rls-new@example.com', 'role' => 'staff', 'name' => 'Rafi'])
            ->assertCreated();
        $token = null;
        Mail::assertQueued(StaffInvitationMail::class, function (StaffInvitationMail $mail) use (&$token) {
            $token = $mail->token;

            return true;
        });

        $this->flushHeaders();
        $this->app['auth']->forgetGuards();
        $this->getJson("/api/v1/invitations/{$token}")->assertOk()->assertJsonPath('data.store_name', 'Rls-invite Store');
        $this->getJson('/api/v1/invitations/'.str_repeat('x', 40))->assertNotFound()->assertJsonPath('error.code', 'invitation_invalid');

        $this->postJson("/api/v1/invitations/{$token}/accept", ['name' => 'Rafi', 'password' => 'secret-pass1', 'password_confirmation' => 'secret-pass1'])
            ->assertCreated();

        $user = User::query()->where('email', 'rls-new@example.com')->sole();
        $this->assertSame('staff', $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('user_id', $user->id)->value('role'));
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'staff.joined')->where('tenant_id', $tenant->id)->exists());
    }

    /** B5 + B6: a slug taken by ANOTHER tenant is a 422 (definer function), not a silent pass or a 500. */
    public function test_store_slug_taken_by_another_tenant_is_422(): void
    {
        [, $tenantA] = $this->merchant();
        $this->storeFor($tenantA, 'taken-slug');
        [$userB, $tenantB] = $this->merchant();

        $this->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->postJson('/api/v1/stores', ['name' => 'B Store', 'slug' => 'taken-slug'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonValidationErrors(['slug'], 'error.details');

        $this->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->postJson('/api/v1/stores', ['name' => 'B Store', 'slug' => 'free-slug'])
            ->assertCreated();
        $this->withHeaders($this->tenantHeaders($userB, $tenantB))
            ->postJson('/api/v1/stores', ['name' => 'B Again', 'slug' => 'free-slug-2'])
            ->assertStatus(409)->assertJsonPath('error.code', 'store_limit_reached');
    }

    /** B10: console commands find work across tenants on pgsql_admin and write inside each tenant. */
    public function test_console_commands_work_across_tenants(): void
    {
        $t = $this->twoTenantsWithOrders();

        $this->platformQuery(Subscription::class)->update(['trial_ends_at' => now()->subDay()]);
        $this->artisan('subscriptions:end-trials')->assertSuccessful();
        $this->assertSame(0, $this->platformQuery(Subscription::class)->where('status', Subscription::TRIALING)->count());

        $this->artisan('stores:ensure-content')->assertSuccessful();
        $this->artisan('shipping:provision-defaults')->assertSuccessful();
        $this->artisan('orders:expire-confirmation-tokens')->assertSuccessful();
        $this->artisan('data:prune-imports')->assertSuccessful();
        $this->artisan('data:expire-exports')->assertSuccessful();

        $this->cartWith($t['a']['store'], $t['a']['variant']);
        $this->cartWith($t['b']['store'], $t['b']['variant']);
        $this->assertSame(2, $this->platformQuery(Cart::class)->where('status', Cart::ACTIVE)->count());
        $this->travel(Cart::TTL_DAYS + 1)->days();
        $this->artisan('carts:prune')->assertSuccessful();
        $this->artisan('idempotency:prune')->assertSuccessful();
        $this->assertSame(0, $this->platformQuery(Cart::class)->where('status', Cart::ACTIVE)->count());
        $this->assertSame(2, $this->platformQuery(Cart::class)->where('status', Cart::ABANDONED)->count());
    }
}
