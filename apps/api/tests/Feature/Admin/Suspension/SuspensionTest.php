<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Suspension;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Suspension\Mail\AdminNoticeMail;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\OnlinePaymentFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/** PHASE-8-1 P8-12 / §4.1 (S80): suspend and reactivate a shop. */
#[Group('admin')]
class SuspensionTest extends TestCase
{
    use OnlinePaymentFixtures, PlatformStaffFixtures, RefreshDatabase, ShipmentFixtures {
        OnlinePaymentFixtures::orderRow insteadof ShipmentFixtures;
    }

    private User $sa;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->sa = $this->staffUser(PlatformRole::SuperAdmin);
    }

    /** @param array<string, mixed> $body */
    private function admin(string $uri, array $body, ?User $as = null): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($as ?? $this->sa))->postJson('/api/v1/admin/'.$uri, $body);
    }

    private function suspend(Tenant $tenant, bool $notify = true): TestResponse
    {
        return $this->admin("tenants/{$tenant->id}/suspend", ['reason_code' => 'fraud', 'reason' => 'Fake orders reported', 'notify' => $notify]);
    }

    private function storeStatus(Tenant $tenant): string
    {
        return (string) $this->inTenant($tenant, fn () => Store::query()->value('status'));
    }

    #[Group('security')]
    public function test_suspend_takes_the_dashboard_and_storefront_offline_and_reactivate_restores_them(): void
    {
        [, $tenant, $store, $h, $variant] = $this->onlineShop('susp');
        $this->sf($store, 'GET', '/config')->assertOk(); // warms the host cache
        Queue::fake([RevalidateStorefront::class]);

        $this->admin("tenants/{$tenant->id}/suspend", ['reason_code' => 'fraud', 'reason' => 'Fake orders reported'], $this->staffUser(PlatformRole::Support))
            ->assertForbidden();
        $this->admin("tenants/{$tenant->id}/suspend", ['reason_code' => 'nope', 'reason' => 'Fake orders reported'])->assertStatus(422);
        $this->admin("tenants/{$tenant->id}/suspend", ['reason_code' => 'fraud'])->assertStatus(422);

        $this->suspend($tenant)->assertOk()->assertJsonPath('data.status', 'suspended')->assertJsonPath('data.store.status', 'suspended')
            ->assertJsonPath('data.suspension.reason_code', 'fraud')->assertJsonPath('data.suspension.store_status_before', 'active');
        $row = $this->platformQuery(Tenant::class)->findOrFail($tenant->id);
        $this->assertSame([Tenant::STATUS_SUSPENDED, 'fraud', $this->sa->id], [$row->status, $row->suspension_reason_code, $row->suspended_by]);
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'tenant.suspended')->sole();
        $this->assertSame(['platform_user', 'Fake orders reported', 'fraud'], [$audit->actor_type, $audit->meta['reason'], $audit->meta['reason_code']]);
        Mail::assertQueued(AdminNoticeMail::class, fn (AdminNoticeMail $m) => $m->kind === AdminNoticeMail::SUSPENDED);
        Queue::assertPushed(RevalidateStorefront::class, fn (RevalidateStorefront $job) => $job->storeId === $store->id);
        $this->assertNull(Cache::get(StorefrontResolver::cacheKey($this->host($store))), 'host cache busted');

        // merchant dashboard: 403 tenant_suspended
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/stores')->assertForbidden()->assertJsonPath('error.code', 'tenant_suspended');
        // storefront: config answers StorefrontSuspended only; cart, catalog and checkout are 404 store_not_found
        $this->sf($store, 'GET', '/config')->assertOk()->assertExactJson(['data' => ['availability' => 'suspended']])
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->assertSame(['tenant_id' => $tenant->id, 'store_id' => $store->id, 'suspended' => true], Cache::get(StorefrontResolver::cacheKey($this->host($store))));
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 1])->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        $this->sf($store, 'GET', '/products')->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        $this->sf($store, 'POST', '/checkout', [], null, ['Idempotency-Key' => 'checkout-0001'])->assertNotFound();

        $this->suspend($tenant)->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        $this->admin("tenants/{$tenant->id}/reactivate", ['reason' => 'Review cleared', 'notify' => true])->assertOk()
            ->assertJsonPath('data.status', 'active')->assertJsonPath('data.store.status', 'active')->assertJsonPath('data.suspension', null);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'tenant.reactivated')->exists());
        Mail::assertQueued(AdminNoticeMail::class, fn (AdminNoticeMail $m) => $m->kind === AdminNoticeMail::REACTIVATED);
        $this->sf($store, 'GET', '/config')->assertOk()->assertJsonPath('data.store.id', $store->id);
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/stores')->assertOk();
        $this->admin("tenants/{$tenant->id}/reactivate", ['reason' => 'Review cleared'])->assertStatus(409);
    }

    public function test_a_draft_store_comes_back_as_draft(): void
    {
        [, $tenant, $store] = $this->shop(slug: 'drafty');
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));

        $this->suspend($tenant, notify: false)->assertOk()->assertJsonPath('data.suspension.store_status_before', 'draft');
        Mail::assertNotQueued(AdminNoticeMail::class);
        $this->admin("tenants/{$tenant->id}/reactivate", ['reason' => 'Review cleared', 'notify' => false])->assertOk();
        $this->assertSame(Store::STATUS_DRAFT, $this->storeStatus($tenant));
    }

    #[Group('security')]
    public function test_in_flight_payment_and_courier_webhooks_still_settle(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop('inflight');
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $paymentId = $r->json('data.payment.payment_id');

        $this->suspend($tenant)->assertOk();
        $this->payOnline($tenant, $paymentId)->assertStatus(303);
        $this->assertSame('succeeded', $this->paymentRow($tenant, $paymentId)->status);
    }

    #[Group('security')]
    public function test_courier_webhook_still_updates_a_suspended_shop(): void
    {
        [, $tenant, $store, $h, $variant, $account] = $this->courierShop('steadfast', 'courierx');
        $order = $this->confirmedOrder($h, $store, $variant);
        $shipment = $this->book($h, $store, $order)->assertCreated()->json('data.id');

        $this->suspend($tenant)->assertOk();
        $this->courierSays($tenant, $shipment, 'in_transit');
        $payload = $this->inTenant($tenant, fn () => $this->fake()->webhookPayload($this->shipmentRow($tenant, $shipment)));
        $this->webhook($account, $payload)->assertOk()->assertExactJson(['data' => ['received' => true]]);
    }

    public function test_check_suspensions_repairs_mismatches_from_the_tenant_status(): void
    {
        [, $suspended] = $this->shop(slug: 'mm-a');
        [, $active] = $this->shop(slug: 'mm-b');
        // crash between the two writes: tenant suspended, store still active …
        $this->platformTable('tenants')->where('id', $suspended->id)->update(['status' => Tenant::STATUS_SUSPENDED, 'suspended_at' => now()]);
        // … and a reactivated tenant whose store is still suspended
        $this->inTenant($active, fn () => Store::query()->update(['status' => Store::STATUS_SUSPENDED, 'status_before_suspension' => Store::STATUS_ACTIVE]));

        $this->artisan('admin:check-suspensions')->expectsOutputToContain('Fixed 2')->assertSuccessful();
        $this->assertSame(Store::STATUS_SUSPENDED, $this->storeStatus($suspended));
        $this->assertSame(Store::STATUS_ACTIVE, $this->storeStatus($active));
        $this->artisan('admin:check-suspensions')->expectsOutputToContain('Fixed 0')->assertSuccessful();
    }
}
