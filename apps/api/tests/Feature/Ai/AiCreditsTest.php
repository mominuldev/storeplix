<?php

declare(strict_types=1);

namespace Tests\Feature\Ai;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Ai\Models\AiCreditAccount;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9D §10 (P89D-33/34/35, S343, S347): the merchant AI credits summary + ledger and the staff adjust endpoints.
 */
#[Group('ai')]
#[Group('security')]
class AiCreditsTest extends TestCase
{
    use AiFixtures, PlatformStaffFixtures, RefreshDatabase;

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpAi();
        $this->staff = $this->staffUser(PlatformRole::Billing);
    }

    /** @param array<string, mixed> $body */
    private function admin(string $method, string $uri, array $body = [], array $headers = [], ?User $as = null): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($as ?? $this->staff) + $headers)
            ->json($method, '/api/v1/admin/'.$uri, $body);
    }

    private function adjust(Tenant $tenant, int $credits, string $reason, ?string $key = null, ?User $as = null): TestResponse
    {
        return $this->admin('POST', "tenants/{$tenant->id}/ai-credits/adjust", ['credits' => $credits, 'reason' => $reason],
            ['Idempotency-Key' => $key ?? (string) Str::ulid()], $as);
    }

    public function test_summary_per_plan_and_shape(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('c1');
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertExactJson(['data' => [
                'allowance' => ['limit' => 20, 'used' => 0, 'remaining' => 20, 'resets_at' => now('Asia/Dhaka')->startOfMonth()->addMonthNoOverflow()->utc()->toIso8601ZuluString()],
                'bonus' => 0, 'available' => 20, 'costs' => ['product_description' => 1, 'photo_edit' => 2],
            ]]);
        foreach (['starter' => 300, 'growth' => 1500] as $plan => $limit) {
            $this->planFor($tenant, $plan);
            $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.limit', $limit);
        }
        $this->describe($h, $store)->assertStatus(202);
        $this->api($h, 'GET', '/api/v1/billing/ai-credits/ledger')->assertOk()->assertJsonPath('meta.per_page', 50)
            ->assertJsonPath('data.0.type', 'consume')->assertJsonPath('data.0.source', 'allowance')->assertJsonPath('data.0.credits', -1)
            ->assertJsonPath('data.0.period', now('Asia/Dhaka')->format('Y-m'))->assertJsonPath('data.0.generation.kind', 'product_description')
            ->assertJsonPath('data.0.reason', null);
        $this->api($h, 'GET', '/api/v1/billing/ai-credits/ledger?filter[type]=refund')->assertOk()->assertJsonCount(0, 'data');
        $this->api($h, 'GET', '/api/v1/billing/ai-credits/ledger?filter[type]=spend')->assertStatus(422);
    }

    public function test_admin_grant_deduct_idempotency_insufficient_and_audit(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('c2');
        $this->admin('GET', "tenants/{$tenant->id}/ai-credits")->assertOk()->assertJsonPath('data.tenant_id', $tenant->id)
            ->assertJsonPath('data.credits.bonus', 0)->assertJsonPath('data.last_adjusted_at', null);

        $key = (string) Str::ulid();
        $this->adjust($tenant, 200, 'Goodwill after outage', $key)->assertOk()->assertJsonPath('data.credits.bonus', 200)->assertJsonPath('data.credits.available', 220);
        $this->adjust($tenant, 200, 'Goodwill after outage', $key)->assertOk()->assertJsonPath('data.credits.bonus', 200); // replay
        $this->adjust($tenant, 300, 'Goodwill after outage', $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->adjust($tenant, -201, 'Correction of a double grant')->assertStatus(422)->assertJsonPath('error.code', 'ai_credits_insufficient');
        $this->adjust($tenant, -50, 'Correction of a double grant')->assertOk()->assertJsonPath('data.credits.bonus', 150);
        $this->assertNotNull($this->admin('GET', "tenants/{$tenant->id}/ai-credits")->json('data.last_adjusted_at'));

        $this->adjust($tenant, 0, 'Zero is not allowed')->assertStatus(422);
        $this->adjust($tenant, 100_001, 'Too many credits')->assertStatus(422);
        $this->adjust($tenant, 5, 'shrt')->assertStatus(422);
        $this->admin('POST', "tenants/{$tenant->id}/ai-credits/adjust", ['credits' => 5, 'reason' => 'No key given'])->assertStatus(400);
        $this->admin('POST', 'tenants/'.strtolower((string) Str::ulid()).'/ai-credits/adjust', ['credits' => 5, 'reason' => 'Unknown shop'],
            ['Idempotency-Key' => (string) Str::ulid()])->assertNotFound();

        $rows = $this->ledger($tenant);
        $this->assertSame([['admin_adjust', null, 200, 200, 'platform'], ['admin_adjust', null, -50, 150, 'platform']],
            $rows->map(fn ($r) => [$r->type, $r->source, $r->credits, $r->bonus_after, $r->actor_type])->all());
        $this->assertSame(150, $this->inTenant($tenant, fn () => AiCreditAccount::query()->value('bonus_balance')));
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'ai_credits.adjusted')->orderBy('created_at')->get();
        $this->assertCount(2, $audit);
        $this->assertSame(['platform_user', $this->staff->id, 'Goodwill after outage', 'billing'],
            [$audit[0]->actor_type, $audit[0]->actor_id, $audit[0]->meta['reason'], $audit[0]->meta['platform_role']]);

        // The merchant sees the reason; the admin ledger mirrors it.
        $this->api($h, 'GET', '/api/v1/billing/ai-credits/ledger?filter[type]=admin_adjust')->assertOk()
            ->assertJsonPath('data.0.reason', 'Correction of a double grant')->assertJsonPath('data.1.reason', 'Goodwill after outage');
        $this->admin('GET', "tenants/{$tenant->id}/ai-credits/ledger")->assertOk()->assertJsonCount(2, 'data')->assertJsonPath('meta.per_page', 50);
        unset($store);
    }

    public function test_admin_reads_need_view_merchants_and_adjust_needs_manage_billing(): void
    {
        [, $tenant, , $h] = $this->aiShop('c3');
        $support = $this->staffUser(PlatformRole::Support);
        $this->admin('GET', "tenants/{$tenant->id}/ai-credits", as: $support)->assertOk();
        $this->admin('GET', "tenants/{$tenant->id}/ai-credits/ledger", as: $support)->assertOk();
        $this->adjust($tenant, 10, 'Support cannot grant', null, $support)->assertForbidden();
        $this->adjust($tenant, 10, 'Super admin grant', null, $this->staffUser(PlatformRole::SuperAdmin))->assertOk()->assertJsonPath('data.credits.bonus', 10);
        // A merchant session never reaches the admin routes; staff without a platform session never reach merchant ones.
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/admin/tenants/{$tenant->id}/ai-credits")->assertForbidden();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->flushHeaders()->withHeaders($staffH)->postJson("/api/v1/admin/tenants/{$tenant->id}/ai-credits/adjust", ['credits' => 5, 'reason' => 'Self grant'])->assertForbidden();
    }

    public function test_tenant_isolation_of_credits(): void
    {
        [, $tenantA, , $hA] = $this->aiShop('ca');
        [, $tenantB, $storeB, $hB] = $this->aiShop('cb');
        $this->describe($hB, $storeB)->assertStatus(202);
        $this->adjust($tenantB, 50, 'Goodwill grant for B')->assertOk();
        $this->api($hA, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.used', 0)->assertJsonPath('data.bonus', 0);
        $this->assertSame([], $this->api($hA, 'GET', '/api/v1/billing/ai-credits/ledger')->json('data'));
        // A's member with B's tenant header is refused (not a member).
        $this->flushHeaders()->withHeaders(['X-Tenant-Id' => $tenantB->id] + $hA)->getJson('/api/v1/billing/ai-credits')->assertStatus(403);
        $this->inTenant($tenantA, fn () => $this->assertSame(0, AiCreditAccount::query()->where('tenant_id', $tenantB->id)->count()));
    }
}
