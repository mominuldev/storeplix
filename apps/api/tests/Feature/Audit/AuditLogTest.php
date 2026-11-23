<?php

namespace Tests\Feature\Audit;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

class AuditLogTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase;

    public function test_lists_this_tenants_logs_with_filters(): void
    {
        [$owner, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($owner, $tenant);
        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['identity' => ['name' => 'Renamed']])->assertOk();
        app(AuditLogger::class)->log('account.profile_updated', $owner, tenantId: false); // account-level: never listed

        $this->withHeaders($headers)->getJson('/api/v1/audit-logs')
            ->assertOk()
            ->assertJsonPath('meta.per_page', 25)
            ->assertJsonPath('data.0.action', 'store.settings_updated')
            ->assertJsonPath('data.0.actor.id', $owner->id)
            ->assertJsonPath('data.0.actor.name', $owner->name)
            ->assertJsonPath('data.0.subject.type', 'store_settings')
            ->assertJsonPath('data.0.meta.changes', ['identity.name'])
            ->assertJsonMissing(['action' => 'account.profile_updated']);

        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?filter[action]=store.*&per_page=1')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('meta.total', 2);
        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?filter[action]=store.created,subscription.trial_started')
            ->assertOk()->assertJsonPath('meta.total', 2);
        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?filter[subject_type]=store&filter[subject_id]='.$store->id)
            ->assertOk()->assertJsonPath('meta.total', 1);
        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?filter[created_at][gte]='.now()->addHour()->toIso8601ZuluString())
            ->assertOk()->assertJsonPath('meta.total', 0);

        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?filter[password]=x')->assertStatus(422);
        $this->withHeaders($headers)->getJson('/api/v1/audit-logs?per_page=500')->assertStatus(422);
    }

    #[Group('tenancy')]
    public function test_another_tenant_cannot_see_your_audit_logs_and_staff_is_forbidden(): void
    {
        [$ownerA, $tenantA] = $this->merchant();
        [$ownerB, $tenantB] = $this->merchant();
        [$staffA] = $this->merchant(TenantUser::ROLE_STAFF, $tenantA);
        $storeA = $this->storeFor($tenantA, 'alpha');

        $this->flushHeaders()->withHeaders($this->tenantHeaders($ownerB, $tenantB))
            ->getJson('/api/v1/audit-logs?filter[subject_id]='.$storeA->id)
            ->assertOk()->assertJsonPath('meta.total', 0);
        $all = $this->getJson('/api/v1/audit-logs')->assertOk();
        $this->assertStringNotContainsString($tenantA->id, $all->getContent());
        $this->assertStringNotContainsString($storeA->id, $all->getContent());

        $this->flushHeaders()->withHeaders($this->tenantHeaders($ownerB, $tenantA))->getJson('/api/v1/audit-logs')->assertForbidden();
        $this->flushHeaders()->withHeaders($this->tenantHeaders($staffA, $tenantA))->getJson('/api/v1/audit-logs')
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    /** P8-QA-1: filter[actor_type]=platform_user lists only "Store Plix support" rows, for this tenant only. */
    #[Group('tenancy')]
    public function test_filters_by_actor_type_and_platform_rows_stay_tenant_scoped(): void
    {
        $staff = $this->staffUser(PlatformRole::Billing, ['name' => 'Secret Staffer']);
        [$ownerA, $tenantA] = $this->merchant();
        [$ownerB, $tenantB] = $this->merchant();
        $this->inTenant($tenantA, fn () => app(AuditLogger::class)->log('billing.period_extended', $tenantA, ['days' => 7], actor: $staff, tenantId: $tenantA->id, platform: true));
        $this->inTenant($tenantA, fn () => app(AuditLogger::class)->log('staff.invited', $tenantA, [], actor: $ownerA, tenantId: $tenantA->id));

        $this->withHeaders($this->tenantHeaders($ownerA, $tenantA))->getJson('/api/v1/audit-logs?filter[actor_type]=platform_user')
            ->assertOk()
            ->assertJsonPath('meta.total', 1)
            ->assertJsonPath('data.0.action', 'billing.period_extended')
            ->assertJsonPath('data.0.actor', ['type' => 'platform_user', 'id' => null, 'name' => 'Store Plix support']);
        $this->getJson('/api/v1/audit-logs?filter[actor_type]=user&filter[action]=staff.*')
            ->assertOk()->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.actor.id', $ownerA->id);
        $this->getJson('/api/v1/audit-logs?filter[actor_type]=admin')->assertStatus(422);

        $this->flushHeaders()->withHeaders($this->tenantHeaders($ownerB, $tenantB))->getJson('/api/v1/audit-logs?filter[actor_type]=platform_user')
            ->assertOk()->assertJsonPath('meta.total', 0);
    }
}
