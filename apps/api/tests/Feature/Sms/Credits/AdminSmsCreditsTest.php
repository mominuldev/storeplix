<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Credits;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-9A §10.3, P89A-18 (S213): staff read a merchant's SMS credits and grant / deduct them. */
#[Group('sms')]
#[Group('admin')]
#[Group('security')]
class AdminSmsCreditsTest extends TestCase
{
    use BillingFixtures, PlatformStaffFixtures, RefreshDatabase, SmsCreditFixtures;

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
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
        return $this->admin('POST', "tenants/{$tenant->id}/sms-credits/adjust", ['credits' => $credits, 'reason' => $reason],
            ['Idempotency-Key' => $key ?? (string) Str::ulid()], $as);
    }

    public function test_grant_deduct_idempotency_and_insufficient(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->admin('GET', "tenants/{$tenant->id}/sms-credits")->assertOk()
            ->assertJsonPath('data', ['balance' => 0, 'status' => 'none', 'low_credit_threshold' => null, 'used_this_month' => 0,
                'purchased_total' => 0, 'last_purchase_at' => null]);

        $key = (string) Str::ulid();
        $this->adjust($tenant, 200, 'Goodwill after outage', $key)->assertOk()->assertJsonPath('data.balance', 200)->assertJsonPath('data.status', 'healthy');
        $this->adjust($tenant, 200, 'Goodwill after outage', $key)->assertOk()->assertJsonPath('data.balance', 200); // replay
        $this->adjust($tenant, 300, 'Goodwill after outage', $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->adjust($tenant, -201, 'Correction of a double grant')->assertStatus(422)->assertJsonPath('error.code', 'sms_credits_insufficient');
        $this->adjust($tenant, -50, 'Correction of a double grant')->assertOk()->assertJsonPath('data.balance', 150);

        // Validation: never 0, bounds, reason 5–500, key required.
        $this->adjust($tenant, 0, 'Zero is not allowed')->assertStatus(422);
        $this->adjust($tenant, 1_000_001, 'Too many credits')->assertStatus(422);
        $this->adjust($tenant, 5, 'shrt')->assertStatus(422);
        $this->admin('POST', "tenants/{$tenant->id}/sms-credits/adjust", ['credits' => 5, 'reason' => 'No key given'])->assertStatus(400);
        $this->admin('POST', 'tenants/'.strtolower((string) Str::ulid()).'/sms-credits/adjust', ['credits' => 5, 'reason' => 'Unknown shop'],
            ['Idempotency-Key' => (string) Str::ulid()])->assertNotFound();

        $rows = $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->orderBy('created_at')->orderBy('id')->get());
        $this->assertSame([[200, 200, 'platform'], [-50, 150, 'platform']], $rows->map(fn ($r) => [$r->credits, $r->balance_after, $r->actor_type])->all());
        $this->assertSame(150, $this->inTenant($tenant, fn () => SmsCreditAccount::query()->value('balance')));
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'sms_credits.adjusted')->orderBy('created_at')->get();
        $this->assertCount(2, $audit);
        $this->assertSame(['platform_user', $this->staff->id, 'Goodwill after outage', 'billing'],
            [$audit[0]->actor_type, $audit[0]->actor_id, $audit[0]->meta['reason'], $audit[0]->meta['platform_role']]);

        // The merchant sees the reason on its ledger.
        $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger?filter[type]=admin_adjust')->assertOk()
            ->assertJsonPath('data.0.reason', 'Correction of a double grant')->assertJsonPath('data.1.reason', 'Goodwill after outage');
        $this->admin('GET', "tenants/{$tenant->id}/sms-credits/ledger")->assertOk()->assertJsonCount(2, 'data')
            ->assertJsonPath('meta.per_page', 50);
    }

    public function test_reads_need_view_merchants_and_adjust_needs_manage_billing(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->buyAndPay($h, $tenant);
        $this->smsAllowance($tenant, 'starter', 1);
        $this->chargeSms($tenant, $store);
        $this->chargeSms($tenant, $store, str_repeat('ক', 80)); // 2 parts from credits
        $readOnly = $this->staffUser(PlatformRole::ReadOnly);
        $support = $this->staffUser(PlatformRole::Support);

        $this->admin('GET', "tenants/{$tenant->id}/sms-credits", as: $readOnly)->assertOk()
            ->assertJsonPath('data.balance', 998)->assertJsonPath('data.used_this_month', 2)->assertJsonPath('data.purchased_total', 1000)
            ->assertJsonPath('data.low_credit_threshold', 200)->assertJsonPath('data.last_purchase_at', fn ($v) => is_string($v));
        $this->admin('GET', "tenants/{$tenant->id}/sms-credits/ledger?filter[type]=consume", as: $support)->assertOk()->assertJsonCount(1, 'data');
        $this->adjust($tenant, 10, 'Read only staff try', null, $readOnly)->assertForbidden();
        $this->adjust($tenant, 10, 'Support staff try', null, $support)->assertForbidden();
        $this->adjust($tenant, 10, 'Super admin grant', null, $this->staffUser(PlatformRole::SuperAdmin))->assertOk()->assertJsonPath('data.balance', 1008);

        // A merchant session never reaches the admin routes.
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/admin/tenants/{$tenant->id}/sms-credits")->assertForbidden();
    }
}
