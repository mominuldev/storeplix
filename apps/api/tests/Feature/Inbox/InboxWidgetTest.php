<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\InboxSms;
use App\Domain\Inbox\Jobs\SendInboxReplySms;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMagicLink;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxWidgetSession;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\WidgetService;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Sms\Charging\SmsChargingFixtures;
use Tests\TestCase;

/** PHASE-8-8E §9: widget sessions, code SMS, unverified fallback, honeypot, reply SMS job, magic links (S236–S240). */
#[Group('inbox')]
#[Group('security')]
class InboxWidgetTest extends TestCase
{
    use InboxFixtures, RefreshDatabase, SmsChargingFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpInbox();
        Mail::fake();
    }

    public function test_code_flow_holds_the_message_until_verified(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->stocked($h, $store, 192000, 5, [], ['slug' => 'blue-panjabi']);
        $start = $this->startChat($store, ['product_slug' => 'blue-panjabi', 'page_path' => '/products/blue-panjabi?utm=x'])->assertCreated();
        $start->assertJsonPath('data.status', 'code_sent')->assertJsonPath('data.phone_masked', '017••••0222')->assertJsonPath('data.resend_after', 60);
        $token = $start->json('data.session_token');
        $this->assertSame(43, strlen($token));
        $this->assertSame(0, $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->count()); // held

        $sms = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'inbox_verify')->sole();
        $this->assertNull($sms->body_preview); // S238: the code is never stored
        $this->assertSame('sent', $sms->status);
        $session = $this->platformQuery(InboxWidgetSession::class)->where('tenant_id', $tenant->id)->sole();
        $this->assertSame(hash('sha256', $token), $session->token_hash);
        $code = $this->sms()->lastCodeFor(self::MSISDN);
        $this->assertStringNotContainsString($code, (string) json_encode($session->getAttributes()));

        $this->chat($store, $token, 'GET', '/session')->assertOk()->assertJsonPath('data.status', 'pending')->assertJsonPath('data.name', 'Rafi Ahmed');
        $this->chat($store, $token, 'POST', '/messages', ['body' => 'hi', 'client_id' => (string) Str::uuid()])->assertStatus(409)
            ->assertJsonPath('error.code', 'inbox_session_unverified');
        $wrong = $code === '000000' ? '111111' : '000000';
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $wrong])->assertUnprocessable()
            ->assertJsonPath('error.code', 'inbox_code_invalid')->assertJsonPath('error.details.attempts_left', 4);
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $code])->assertOk()->assertJsonPath('data', ['status' => 'verified', 'unread_count' => 0]);

        $c = $this->conversationOf($tenant, 'web_chat');
        $this->assertSame(['phone:'.self::MSISDN, 'verified_phone', '/products/blue-panjabi', '/products/blue-panjabi'],
            [$c->thread_key, $c->identity, $c->source_path, $c->context['path'] ?? null]);
        $this->assertSame(192000, $c->context['price_amount']);
        $this->chat($store, $token, 'GET', '/messages')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.from', 'customer');
    }

    public function test_five_wrong_codes_burn_the_code_and_resend_has_a_cooldown(): void
    {
        [, $tenant, $store] = $this->inboxShop();
        $token = $this->startChat($store)->assertCreated()->json('data.session_token');
        $code = $this->sms()->lastCodeFor(self::MSISDN);
        $wrong = $code === '000000' ? '111111' : '000000';
        for ($i = 4; $i >= 0; $i--) {
            $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $wrong])->assertJsonPath('error.details.attempts_left', $i);
        }
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $code])->assertUnprocessable()->assertJsonPath('error.code', 'inbox_code_expired');
        $this->chat($store, $token, 'POST', '/sessions/resend')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->travel(61)->seconds();
        $this->chat($store, $token, 'POST', '/sessions/resend')->assertOk()->assertJsonPath('data.status', 'pending');
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $this->sms()->lastCodeFor(self::MSISDN)])->assertOk();
        // Expiry after 10 minutes.
        $t2 = $this->startChat($store, ['phone' => '01711000999'])->json('data.session_token');
        $this->travel(11)->minutes();
        $this->chat($store, $t2, 'POST', '/sessions/verify', ['code' => $this->sms()->lastCodeFor('8801711000999')])->assertJsonPath('error.code', 'inbox_code_expired');
    }

    public function test_unverified_fallback_when_sms_cannot_be_paid_or_sent(): void
    {
        [, $tenant, $store] = $this->inboxShop();
        $this->smsPlan($tenant, 'free', 0, 0);
        $r = $this->startChat($store)->assertCreated()->assertJsonPath('data.status', 'unverified')->assertJsonPath('data.resend_after', null);
        $c = $this->conversationOf($tenant, 'web_chat');
        $this->assertSame(['unverified', null], [$c->identity, $c->customer_id]);
        $this->assertStringStartsWith('session:', $c->thread_key);
        $this->chat($store, $r->json('data.session_token'), 'POST', '/messages', ['body' => 'still there?', 'client_id' => (string) Str::uuid()])->assertCreated();

        // Provider failure → unverified too.
        $this->smsPlan($tenant, 'free', 200, 0);
        $this->sms()->failNext = true;
        $this->startChat($store, ['phone' => '01811000123'])->assertCreated()->assertJsonPath('data.status', 'unverified');
        $this->assertSame('failed', $this->platformQuery(SmsMessage::class)->where('to', '8801811000123')->value('status'));
    }

    public function test_honeypot_validation_draft_store_channel_off_and_key(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->startChat($store, ['website' => 'http://spam'])->assertStatus(202)->assertJsonStructure(['data' => ['session_token']]);
        $this->assertSame(0, $this->platformQuery(InboxWidgetSession::class)->where('tenant_id', $tenant->id)->count());
        $this->assertSame([], $this->sms()->sent);

        $this->startChat($store, ['phone' => '12345'])->assertUnprocessable()->assertJsonValidationErrors(['phone'], 'error.details');
        $this->startChat($store, ['message' => str_repeat('x', 2001)])->assertUnprocessable();
        $this->startChat($store, ['message' => "\x01\x02"])->assertUnprocessable();
        $this->startChat($store, [], UploadedFile::fake()->createWithContent('x.gif', $this->imageBytes(50, 50, 'gif')))->assertUnprocessable()
            ->assertJsonValidationErrors(['file'], 'error.details');
        $this->startChat($store, [], null, ['X-Storefront-Key' => 'wrong'])->assertStatus(401)->assertJsonPath('error.code', 'invalid_storefront_key');
        $this->chat($store, str_repeat('a', 43), 'GET', '/session')->assertNotFound()->assertJsonPath('error.code', 'inbox_session_invalid');

        $this->channels($h, $store, ['web_chat_enabled' => false]);
        $this->startChat($store)->assertNotFound()->assertJsonPath('error.code', 'inbox_unavailable');
        $this->sf($store, 'GET', '/config')->assertOk()->assertJsonPath('data.inbox.web_chat', null)->assertJsonPath('data.inbox.order_messages', true);

        $this->channels($h, $store, ['web_chat_enabled' => true]);
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->startChat($store)->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
        $this->sf($store, 'GET', '/config')->assertOk()->assertJsonPath('data.inbox', null);
    }

    public function test_a_session_never_works_on_another_store(): void
    {
        [, $tenantA, $storeA] = $this->inboxShop('alpha');
        [, , $storeB] = $this->inboxShop('beta');
        [$token, $id] = $this->verifiedChat($tenantA, $storeA);
        $this->chat($storeB, $token, 'GET', '/session')->assertNotFound()->assertJsonPath('error.code', 'inbox_session_invalid');
        $this->chat($storeB, $token, 'GET', '/messages')->assertNotFound();
        $this->chat($storeB, $token, 'POST', '/messages', ['body' => 'x', 'client_id' => (string) Str::uuid()])->assertNotFound();
        // Storefront host of A with B's key header is still A (host decides); a foreign host is 404 store_not_found.
        $this->sf($storeA, 'GET', '/inbox/session', [], null, ['X-Inbox-Session' => $token, 'X-Storefront-Host' => 'nope.example.com'])->assertNotFound();
    }

    public function test_notes_and_system_rows_never_reach_the_shopper(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        [$token, $id] = $this->verifiedChat($tenant, $store);
        $pdf = $this->inboxUpload($h, $store, 'secret.pdf', self::pdf())->json('data.id');
        $this->reply($h, $store, $id, 'SECRET NOTE', ['kind' => 'note', 'attachment_ids' => [$pdf]])->assertCreated();
        $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/status"), ['status' => 'pending'])->assertOk();
        $this->reply($h, $store, $id, 'Public reply https://example.com/x.')->assertCreated();

        $rows = $this->chat($store, $token, 'GET', '/messages')->assertOk()->json('data');
        $this->assertSame(['customer', 'shop'], array_column($rows, 'from'));
        $this->assertSame($store->name, $rows[1]['author_name']);
        $this->assertStringNotContainsString('SECRET', (string) json_encode($rows));
        $this->chat($store, $token, 'GET', "/attachments/{$pdf}")->assertNotFound();
        $this->chat($store, $token, 'GET', '/session')->assertJsonPath('data.unread_count', 1);
    }

    public function test_reply_sms_job_rules_seen_throttle_no_credits_failed_and_magic_link(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        [$token, $id] = $this->verifiedChat($tenant, $store);
        $run = fn (string $messageId) => (new SendInboxReplySms($messageId))->forTenant($tenant->id)->handle(...$this->jobDeps());

        // Delayed 2 minutes.
        $m1 = $this->reply($h, $store, $id, 'One')->json('data.id');
        Bus::assertDispatched(SendInboxReplySms::class, fn (SendInboxReplySms $j) => $j->messageId === $m1 && $j->delay !== null && $j->queue === 'sms');

        // Seen meanwhile → skipped.
        $this->chat($store, $token, 'POST', '/messages/seen')->assertNoContent();
        $this->assertSame('seen', $this->msg($tenant, $m1)->sms_status);
        $this->inTenant($tenant, fn () => $run($m1));
        $this->assertSame('seen', $this->msg($tenant, $m1)->sms_status);

        // Sent with a magic link; the preview hides the link.
        $this->travel(1)->minutes();
        $m2 = $this->reply($h, $store, $id, 'Two')->json('data.id');
        $sent = count($this->sms()->sent);
        $this->inTenant($tenant, fn () => $run($m2));
        $this->assertSame('sent', $this->msg($tenant, $m2)->sms_status);
        $text = $this->sms()->sent[$sent]['text'];
        $this->assertSame(self::MSISDN, $this->sms()->sent[$sent]['to']);
        $this->assertMatchesRegularExpression('~https://[^/]+/m/([A-Za-z0-9]{22})$~', $text);
        preg_match('~/m/([A-Za-z0-9]{22})$~', $text, $mm);
        $row = $this->platformQuery(SmsMessage::class)->where('purpose', 'inbox_reply')->sole();
        $this->assertSame(['conversation', $id], [$row->reference_type, $row->reference_id]);
        $this->assertStringContainsString('[link]', (string) $row->body_preview);

        // Within 30 minutes → throttled.
        $m3 = $this->reply($h, $store, $id, 'Three')->json('data.id');
        $this->inTenant($tenant, fn () => $run($m3));
        $this->assertSame('throttled', $this->msg($tenant, $m3)->sms_status);

        // No allowance and no credits → no_credits; provider failure → failed (credits refunded by the charger).
        $this->travel(31)->minutes();
        $this->smsPlan($tenant, 'free', 0, 0);
        $m4 = $this->reply($h, $store, $id, 'Four')->json('data.id');
        $this->inTenant($tenant, fn () => $run($m4));
        $this->assertSame('no_credits', $this->msg($tenant, $m4)->sms_status);
        $this->smsPlan($tenant, 'starter', 1, 0);
        $this->usedSms($tenant, 5);
        $this->giveCredits($tenant, 10);
        $this->sms()->failNext = true;
        $m5 = $this->reply($h, $store, $id, 'Five')->json('data.id');
        $this->inTenant($tenant, fn () => $run($m5));
        $this->assertSame('failed', $this->msg($tenant, $m5)->sms_status);
        $this->assertSame(10, $this->balance($tenant));
        $this->assertLedgerMatches($tenant);
        $this->assertNull($this->conversationRow($tenant, $id)->reply_sms_sent_at?->gt(now()->subMinutes(5)) ? 'recent' : null);

        // Magic link → a new verified session on the same conversation.
        $link = $this->sf($store, 'POST', '/inbox/links/'.$mm[1])->assertOk()->assertJsonPath('data.kind', 'chat');
        $this->chat($store, $link->json('data.session_token'), 'GET', '/messages')->assertOk()->assertJsonPath('data.0.from', 'customer');
        $this->sf($store, 'POST', '/inbox/links/'.Str::random(22))->assertNotFound()->assertJsonPath('error.code', 'inbox_link_invalid');
        $this->platformQuery(InboxMagicLink::class)->update(['expires_at' => now()->subMinute()]);
        $this->sf($store, 'POST', '/inbox/links/'.$mm[1])->assertNotFound();
    }

    public function test_unverified_threads_and_blocked_conversations_are_never_texted(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->smsPlan($tenant, 'free', 0, 0);
        $this->startChat($store)->assertJsonPath('data.status', 'unverified');
        $id = $this->conversationOf($tenant, 'web_chat')->id;
        $this->reply($h, $store, $id)->assertCreated()->assertJsonPath('data.sms_status', 'not_applicable');
        Bus::assertNotDispatched(SendInboxReplySms::class);
    }

    public function test_limiters_start_and_messages(): void
    {
        $this->withMiddleware(ThrottleRequests::class);
        [, , $store] = $this->inboxShop();
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.7'];
        foreach (['01711000301', '01711000302', '01711000303', '01711000304', '01711000305'] as $phone) {
            $this->startChat($store, ['phone' => $phone], null, $ip)->assertCreated();
        }
        $this->startChat($store, ['phone' => '01711000306'], null, $ip)->assertStatus(429);
        // 3 per phone per hour from different IPs.
        for ($i = 1; $i <= 3; $i++) {
            $this->startChat($store, ['phone' => '01911000777'], null, ['X-Storefront-Client-Ip' => "198.51.100.{$i}0"])->assertCreated();
        }
        $this->startChat($store, ['phone' => '01911000777'], null, ['X-Storefront-Client-Ip' => '198.51.100.99'])->assertStatus(429);
        $this->sf($store, 'POST', '/inbox/links/'.Str::random(22), [], null, $ip)->assertNotFound();
    }

    /** @return array<int, object> */
    private function jobDeps(): array
    {
        return [app(InboxSms::class), app(WidgetService::class), app(InboxVersion::class)];
    }

    private function msg(Tenant $tenant, string $id): InboxMessage
    {
        return $this->platformQuery(InboxMessage::class)->where('tenant_id', $tenant->id)->whereKey($id)->firstOrFail();
    }
}
