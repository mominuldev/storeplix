<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Credits;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Mail\SmsMail;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-9A §5.1, §5.5, §5.6, P89A-12 (S219): account read, ledger, low-credit alert and the PATCH. */
#[Group('sms')]
#[Group('billing')]
class SmsCreditAccountTest extends TestCase
{
    use BillingFixtures, RefreshDatabase, SmsCreditFixtures, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function account(Tenant $tenant): SmsCreditAccount
    {
        return $this->inTenant($tenant, fn () => SmsCreditAccount::query()->firstOrFail());
    }

    public function test_patch_threshold_validates_audits_and_re_arms(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->api($h, 'PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 300])->assertStatus(422);
        $this->api($h, 'PATCH', '/api/v1/billing/sms-credits', [])->assertStatus(422);
        $this->api($h, 'PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 500])->assertOk()
            ->assertJsonPath('data.low_credit_threshold', 500);
        $this->inTenant($tenant, fn () => DB::table('sms_credit_accounts')->update(['low_alert_sent_at' => now()]));
        $this->api($h, 'PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => null])->assertOk()
            ->assertJsonPath('data.low_credit_threshold', null);
        $this->assertNull($this->account($tenant)->low_alert_sent_at, 'a threshold change always re-arms');
        $rows = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'sms_credits.alert_updated')->orderBy('created_at')->get();
        $this->assertCount(2, $rows);
        $this->assertSame(['from' => 500, 'to' => null], $rows[1]->meta);
    }

    public function test_low_credit_alert_once_per_crossing_and_re_armed_by_a_purchase(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->buyAndPay($h, $tenant); // 1,000 credits, threshold 200
        $this->smsAllowance($tenant, 'starter', 1);
        $this->chargeSms($tenant, $store); // uses the allowance
        $this->inTenant($tenant, fn () => DB::table('sms_credit_accounts')->update(['balance' => 201])); // shortcut: alert maths only

        $first = $this->chargeSms($tenant, $store);
        $this->assertSame('credits', $first->from);
        Mail::assertNotQueued(SmsMail::class); // 200 is not below 200
        $this->chargeSms($tenant, $store); // 199 → crossing
        $this->chargeSms($tenant, $store); // 198 → still below: no second email
        Mail::assertQueued(SmsMail::class, 1);
        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::LOW_CREDITS && $m->data['balance'] === '199');
        $this->assertNotNull($this->account($tenant)->low_alert_sent_at);
        $this->api($h, 'GET', '/api/v1/billing/sms-credits')->assertOk()->assertJsonPath('data.status', 'low')
            ->assertJsonPath('data.estimated_days_left', fn ($d) => is_int($d));

        $this->buyAndPay($h, $tenant); // back above 200 → re-armed
        $this->assertNull($this->account($tenant)->low_alert_sent_at);
        $this->assertSame(1198, $this->account($tenant)->balance);
    }

    public function test_ledger_filters_cursor_and_validation(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->buyAndPay($h, $tenant);
        $this->smsAllowance($tenant, 'starter', 1);
        $this->chargeSms($tenant, $store);
        for ($i = 0; $i < 55; $i++) {
            $this->travel(1)->seconds();
            $this->chargeSms($tenant, $store);
        }
        $page = $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger')->assertOk()->assertJsonCount(50, 'data')
            ->assertJsonPath('data.0.type', 'consume')->assertJsonPath('data.0.credits', -1)
            ->assertJsonPath('data.0.sms_message_id', fn ($id) => is_string($id))->assertJsonPath('data.0.invoice', null);
        $next = (string) $page->json('meta.next_cursor');
        $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger?cursor='.urlencode($next))->assertOk()->assertJsonCount(6, 'data')
            ->assertJsonPath('data.5.type', 'purchase');
        $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger?filter[type]=purchase,refund')->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger?filter[type]=gift')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(945, $this->account($tenant)->balance);
        $sum = $this->inTenant($tenant, fn () => (int) SmsCreditLedgerEntry::query()->sum('credits'));
        $this->assertSame(945, $sum, 'balance = ledger sum');
    }

    #[Group('security')]
    public function test_impersonation_reads_but_cannot_buy_or_change_the_alert(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->buyAndPay($h, $tenant);
        $this->useSpaBrowser();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: SMS credits check', 'ZD-89', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];

        $this->browser('GET', '/api/v1/billing/sms-credits', [], $t)->assertOk()->assertJsonPath('data.balance', 1000);
        $this->browser('GET', '/api/v1/billing/sms-credits/ledger', [], $t)->assertOk();
        $this->browser('PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 100], $t)->assertForbidden()
            ->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('POST', '/api/v1/billing/sms-credits/purchase', ['pack' => 'credits_1000', 'provider' => 'bkash'], $t + ['Idempotency-Key' => (string) Str::ulid()])
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->assertSame(200, $this->account($tenant)->low_credit_threshold);
    }
}
