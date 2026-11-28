<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Overview;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-9A §6 (P89A-1, P89A-2, P89A-22, P89A-23, P89A-25; S208, S210, S218): overview and test SMS. */
#[Group('sms')]
class SmsOverviewApiTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsSliceFixtures, SpaBrowser;

    public function test_overview_shape_stats_and_flags(): void
    {
        [, $tenant, $store, $h] = $this->smsShop();
        $first = $this->smsRow($tenant, $store, ['created_at' => now()->subMinutes(30), 'sent_at' => now()->subMinutes(30)]);
        $this->smsRow($tenant, $store, ['status' => 'failed', 'charged_from' => null, 'error_code' => 'provider_error']);
        $this->smsRow($tenant, $store, ['status' => 'skipped', 'charged_from' => null, 'error_code' => 'no_credits']);
        $this->smsRow($tenant, $store, ['purpose' => 'checkout_otp', 'template' => 'checkout_otp.bn']);
        $this->smsRow(null, null, ['purpose' => 'otp_login', 'template' => 'otp_login']); // account code: never counted
        $this->smsRow($tenant, $store, ['purpose' => 'otp_signup', 'template' => 'otp_signup']); // never counted either

        $r = $this->api($h, 'GET', $this->smsUrl($store))->assertOk()
            ->assertJsonPath('data.gateway.provider', 'revesms')->assertJsonPath('data.gateway.status', 'connected')
            ->assertJsonPath('data.sender', ['type' => 'shared', 'sender_id' => null, 'pending_request' => null])
            ->assertJsonPath('data.language', 'bn')
            ->assertJsonPath('data.allowance.transactional.limit', 200)
            ->assertJsonPath('data.allowance.transactional.unit', 'messages')
            ->assertJsonPath('data.allowance.marketing', ['limit' => 0, 'used' => 0, 'remaining' => 0, 'unit' => 'parts'])
            ->assertJsonPath('data.credits.status', 'none')->assertJsonPath('data.credits.balance', 0)
            ->assertJsonPath('data.this_month.messages_sent', 2)
            ->assertJsonPath('data.this_month.messages_failed', 1)
            ->assertJsonPath('data.this_month.messages_skipped', 1)
            ->assertJsonPath('data.this_month.otp_sent', 1)
            ->assertJsonPath('data.this_month.credits_used', 0)
            ->assertJsonPath('data.quiet_hours.from', '21:00')->assertJsonPath('data.quiet_hours.to', '09:00')
            ->assertJsonPath('data.quiet_hours.timezone', 'Asia/Dhaka')
            ->assertJsonPath('data.can', ['edit_templates' => true, 'send_test' => true, 'view_log' => true, 'view_sender_ids' => true,
                'request_sender_id' => true, 'view_credit_history' => true, 'buy_credits' => true, 'edit_low_credit_alert' => true]);
        $this->assertEqualsWithDelta(2 / 3, $r->json('data.this_month.sent_success_rate'), 0.001);
        $this->assertNotNull($r->json('data.gateway.active_since'));
        $this->assertSame(2, $r->json('data.allowance.transactional.used')); // 1 order SMS + 1 checkout code sent (failed, skipped, otp_* don't count)
        $this->assertIsString($first);

        // Admin (Manager): everything but buying; staff: 403.
        [, $ha] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->api($ha, 'GET', $this->smsUrl($store))->assertOk()->assertJsonPath('data.can.buy_credits', false)
            ->assertJsonPath('data.can.edit_templates', true)->assertJsonPath('data.can.view_credit_history', true);
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($hs, 'GET', $this->smsUrl($store))->assertForbidden();
        $this->api($hs, 'POST', $this->smsUrl($store, '/test'))->assertForbidden();
    }

    public function test_growth_unlimited_null_rate_masked_sender_and_credit_status(): void
    {
        [, $tenant, $store, $h] = $this->smsShop();
        $this->onPlan($tenant, 'growth');
        $this->senderRow($tenant, $store, 'GadgetBD');
        $this->grantCredits($tenant, 150);
        $this->api($h, 'GET', $this->smsUrl($store))->assertOk()
            ->assertJsonPath('data.allowance.transactional.limit', null)->assertJsonPath('data.allowance.transactional.remaining', null)
            ->assertJsonPath('data.this_month.sent_success_rate', null)
            ->assertJsonPath('data.sender.type', 'masked')->assertJsonPath('data.sender.sender_id', 'GadgetBD')
            ->assertJsonPath('data.credits.balance', 150)->assertJsonPath('data.credits.status', 'healthy')
            ->assertJsonPath('data.gateway.active_since', null);
    }

    public function test_pending_request_shows_on_the_overview(): void
    {
        [, $tenant, $store, $h] = $this->smsShop();
        $id = $this->senderRow($tenant, $store, 'NEWID', 'pending');
        $this->api($h, 'GET', $this->smsUrl($store))->assertOk()
            ->assertJsonPath('data.sender.type', 'shared')
            ->assertJsonPath('data.sender.pending_request.id', $id)
            ->assertJsonPath('data.sender.pending_request.status', 'pending')
            ->assertJsonPath('data.sender.pending_request.document.mime', 'application/pdf');
    }

    #[Group('security')]
    #[Group('tenancy')]
    public function test_isolation_other_tenant_and_other_store_are_404(): void
    {
        [, , $storeA, $hA] = $this->smsShop('shopa');
        [, , $storeB] = $this->liveShop('shopb');
        $this->assertTenantIsolation($hA, [
            ['GET', $this->smsUrl($storeB)],
            ['POST', $this->smsUrl($storeB, '/test')],
            ['GET', $this->smsUrl($storeB, '/templates')],
            ['POST', $this->smsUrl($storeB, '/templates/preview'), ['key' => 'order_placed', 'language' => 'bn', 'body' => 'Hi {shop}']],
            ['PUT', $this->smsUrl($storeB, '/templates/order_placed/bn'), ['body' => 'Hi {shop}']],
            ['DELETE', $this->smsUrl($storeB, '/templates/order_placed/bn')],
            ['GET', $this->smsUrl($storeB, '/messages')],
        ]);
        $this->api($hA, 'GET', $this->smsUrl($storeA))->assertOk();
    }

    public function test_send_test_sms_from_allowance_then_credits_then_402(): void
    {
        Mail::fake();
        [$owner, $tenant, $store, $h] = $this->smsShop();
        $this->api($h, 'POST', $this->smsUrl($store, '/test'))->assertStatus(422)->assertJsonPath('error.code', 'phone_not_verified');
        $this->verifiedPhone($owner);

        $r = $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'en', 'to' => '01999999999'])->assertOk()
            ->assertJsonPath('data.to_masked', '01711-•••211')->assertJsonPath('data.status', 'sent')
            ->assertJsonPath('data.charged_from', 'allowance')->assertJsonPath('data.parts', 1);
        $this->assertSame([['to' => '8801711552211', 'text' => 'Shop Store: This is a test SMS from Store Plix. Your shop\'s SMS is working.', 'sender_id' => null]],
            array_map(fn ($m) => ['to' => $m['to'], 'text' => preg_replace('/^Shop\w* Store/', 'Shop Store', $m['text']), 'sender_id' => $m['sender_id']], $this->sent()));
        $row = $this->platformQuery(SmsMessage::class)->findOrFail($r->json('data.sms_message_id'));
        $this->assertSame(['sms_test', 'sent', 'transactional', $store->id], [$row->purpose, $row->status, $row->kind, $row->store_id]);
        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sms.test_sent')->first();
        $meta = json_decode((string) $audit->meta, true);
        $this->assertSame(['to_masked' => '01711-•••211', 'parts' => 1, 'charged_from' => 'allowance'], array_intersect_key($meta, array_flip(['to_masked', 'parts', 'charged_from'])));
        $this->assertStringNotContainsString('8801711552211', (string) $audit->meta);

        // Allowance used up: credits (Bangla text: 2 parts), then nothing left → 402 with the row skipped.
        $this->useUpAllowance($tenant, $store);
        $this->grantCredits($tenant, 3);
        $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'bn'])->assertOk()
            ->assertJsonPath('data.charged_from', 'credits')->assertJsonPath('data.parts', 2);
        $this->assertSame(1, $this->balance($tenant));
        $skipped = $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'bn'])->assertStatus(402)
            ->assertJsonPath('error.code', 'sms_credits_exhausted')
            ->assertJsonPath('error.details', ['allowance_remaining' => 0, 'credits' => 1, 'needed' => 2]);
        $this->assertSame(1, $this->platformQuery(SmsMessage::class)->where('purpose', 'sms_test')->where('status', 'skipped')->where('error_code', 'no_credits')->count());
        $this->assertCount(2, $this->sent());
        $this->assertNotNull($skipped);
    }

    public function test_provider_failure_refunds_and_answers_502(): void
    {
        [$owner, $tenant, $store, $h] = $this->smsShop();
        $this->verifiedPhone($owner);
        $this->useUpAllowance($tenant, $store);
        $this->grantCredits($tenant, 5);
        app(SmsGateway::class)->failNext = true;
        $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'en'])->assertStatus(502)->assertJsonPath('error.code', 'provider_error');
        $this->assertSame(5, $this->balance($tenant));
        $types = $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->orderBy('created_at')->orderBy('id')->pluck('type')->all());
        $this->assertSame(['admin_adjust', 'consume', 'refund'], $types);
        $this->assertSame('failed', $this->platformQuery(SmsMessage::class)->where('purpose', 'sms_test')->value('status'));
    }

    public function test_masked_sender_drops_the_prefix_on_the_test_sms(): void
    {
        [$owner, $tenant, $store, $h] = $this->smsShop();
        $this->verifiedPhone($owner);
        $this->senderRow($tenant, $store, 'GadgetBD');
        $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'en'])->assertOk();
        $this->assertSame("This is a test SMS from Store Plix. Your shop's SMS is working.", $this->sent()[0]['text']);
        $this->assertSame('GadgetBD', $this->sent()[0]['sender_id']);
    }

    #[Group('security')]
    public function test_limiter_five_per_hour(): void
    {
        [$owner, , $store, $h] = $this->smsShop();
        $this->verifiedPhone($owner);
        foreach (range(1, 5) as $i) {
            $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'en'])->assertOk();
        }
        $this->api($h, 'POST', $this->smsUrl($store, '/test'), ['language' => 'en'])->assertStatus(429);
    }

    #[Group('security')]
    public function test_impersonation_reads_but_cannot_write(): void
    {
        [$owner, $tenant, $store] = $this->smsShop();
        $this->verifiedPhone($owner);
        $this->useSpaBrowser();
        Mail::fake();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: SMS check', 'ZD-89', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', $this->smsUrl($store), [], $t)->assertOk();
        $this->browser('GET', $this->smsUrl($store, '/templates'), [], $t)->assertOk();
        $this->browser('GET', $this->smsUrl($store, '/messages'), [], $t)->assertOk();
        foreach ([
            ['POST', '/test', []],
            ['POST', '/templates/preview', ['key' => 'order_placed', 'language' => 'en', 'body' => 'Hi {shop}']],
            ['PUT', '/templates/order_placed/en', ['body' => 'Hi {shop}']],
            ['DELETE', '/templates/order_placed/en', []],
        ] as [$method, $path, $body]) {
            $this->browser($method, $this->smsUrl($store, $path), $body, $t)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        }
        $this->assertCount(0, $this->sent());
    }
}
