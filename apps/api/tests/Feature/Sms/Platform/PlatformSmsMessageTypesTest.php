<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Platform\PlatformSmsTemplates;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §6 (P89B-11 – P89B-15, S226, S227): catalogue + KPIs + group meta; switches (locked 422, broadcast off while
 * pending 409); templates (merge-field allow-list, required fields, no typed links, ≤ 3 parts, revision, saving the
 * default resets, reset idempotent); preview; "Send test to me" (locked texts with a sample code, never stored).
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class PlatformSmsMessageTypesTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
    }

    public function test_catalogue_kpis_and_groups(): void
    {
        $this->reveOk();
        $this->useRouter();
        $this->activeProvider($this->reveInput());
        SmsMessage::query()->create(['tenant_id' => null, 'to' => '8801711111111', 'purpose' => 'otp_login', 'template' => 'otp_code', 'status' => 'sent', 'parts' => 1]);
        SmsMessage::query()->create(['tenant_id' => null, 'to' => '8801711111111', 'purpose' => 'platform_broadcast', 'template' => 't', 'status' => 'sent', 'parts' => 2]);
        $response = $this->admin('GET', 'message-types')->assertOk();
        $this->assertSame(PlatformSmsType::cases()[0]->value, $response->json('data.0.type'));
        $this->assertCount(9, $response->json('data'));
        $byType = collect($response->json('data'))->keyBy('type');
        $this->assertTrue($byType['sign_in_code']['locked']);
        $this->assertNull($byType['sign_in_code']['enabled']);
        $this->assertFalse($byType['sign_in_code']['editable']);
        $this->assertSame('Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.', $byType['sign_in_code']['templates'][0]['body']);
        $this->assertSame('Your Store Plix code is 482913. Valid for 5 minutes. Do not share it.', $byType['sign_in_code']['templates'][1]['preview']);
        $this->assertSame([], $byType['broadcast']['templates']);
        $this->assertSame('promotional', $byType['broadcast']['sender']);
        $this->assertSame(['invoice_no', 'link'], $byType['invoice_issued']['required_fields']);
        $this->assertSame(['bn', 'en'], array_column($byType['welcome']['templates'], 'language'));
        $this->assertSame(1, $byType['sign_in_code']['sent_this_month']);
        $response->assertJsonPath('meta.kpis.sent_this_month', 3)->assertJsonPath('meta.kpis.codes_this_month', 1)
            ->assertJsonPath('meta.kpis.promotional_this_month', 1);
        $groups = collect($response->json('meta.groups'))->keyBy('group');
        $this->assertSame('Storeplix', $groups['billing']['sender_id']);
        $this->assertSame('StorePlixP', $groups['promotional']['sender_id']);
        $this->assertSame('REVE Main', $groups['security']['provider']['name']);
    }

    public function test_switches(): void
    {
        $this->admin('PATCH', 'message-types/sign_in_code', ['enabled' => false])->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_type_locked');
        $this->admin('PATCH', 'message-types/nope', ['enabled' => false])->assertNotFound();
        $this->admin('PATCH', 'message-types/welcome', ['enabled' => 'maybe'])->assertStatus(422);
        $this->admin('PATCH', 'message-types/welcome', ['enabled' => false])->assertOk()->assertJsonPath('data.enabled', false);
        $this->assertFalse(PlatformSmsTemplates::enabled(PlatformSmsType::Welcome));
        $this->assertSame(['from' => true, 'to' => false], $this->platformQuery(AuditLog::class)->where('action', 'platform_sms_type.updated')->sole()->meta['enabled']);

        $b = new PlatformSmsBroadcast;
        $b->setConnection(PlatformDb::connectionName());
        $b->forceFill(['name' => 'X', 'body_bn' => 'x', 'body_en' => 'x', 'audience' => ['kind' => 'all'], 'status' => 'scheduled'])->save();
        $this->admin('PATCH', 'message-types/broadcast', ['enabled' => false])->assertStatus(409)->assertJsonPath('error.code', 'broadcasts_pending');
        $b->forceFill(['status' => 'cancelled'])->save();
        $this->admin('PATCH', 'message-types/broadcast', ['enabled' => false])->assertOk();
    }

    public function test_template_rules_revision_and_reset(): void
    {
        $put = fn (string $body, int $revision = 0, string $type = 'invoice_issued', string $lang = 'en') => $this->admin('PUT', "message-types/{$type}/templates/{$lang}", ['body' => $body, 'revision' => $revision]);
        $put('Code {otp}', 0, 'sign_in_code')->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_type_locked');
        $put('Hi', 0, 'broadcast')->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_type_locked');
        $put('Invoice {invoice_no} {coupon} {link}')->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_template_unknown_merge_field')->assertJsonPath('error.details.fields', ['coupon']);
        $put('Invoice {invoice_no} {otp} {link}')->assertStatus(422)->assertJsonPath('error.details.fields', ['otp']);
        $put('Invoice {invoice_no} due')->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_template_missing_merge_field')->assertJsonPath('error.details.fields', ['link']);
        $put('Pay {invoice_no} at https://evil.example {link}')->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_template_link_not_allowed');
        $put(str_repeat('Long text. ', 45).'{invoice_no} {link}')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $put(str_repeat('অনেক লম্বা ', 20).'{invoice_no} {link}', 0, 'invoice_issued', 'bn')->assertStatus(422)
            ->assertJsonPath('error.code', 'platform_sms_template_too_long')->assertJsonPath('error.details.max_parts', 3);
        $this->admin('PUT', 'message-types/invoice_issued/templates/fr', ['body' => 'x', 'revision' => 0])->assertNotFound();

        $put("Store Plix: invoice {invoice_no}\nfor {plan}. Pay: {link}")->assertOk()->assertJsonPath('data.is_custom', true)->assertJsonPath('data.revision', 1)
            ->assertJsonPath('data.body', 'Store Plix: invoice {invoice_no} for {plan}. Pay: {link}')
            ->assertJsonPath('data.preview', 'Store Plix: invoice SP-2026-001042 for Growth. Pay: http://localhost:5183/settings/plan')
            ->assertJsonPath('data.updated_by.id', $this->super()->id);
        $put('Store Plix: {invoice_no} {link}', 0)->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $put('Store Plix: {invoice_no} {link}', 1)->assertOk()->assertJsonPath('data.revision', 2);
        $this->assertSame('Store Plix: {invoice_no} {link}', PlatformSmsTemplates::body(PlatformSmsType::InvoiceIssued, 'en'));

        // Saving the default text deletes the custom row.
        $put(PlatformSmsTemplates::defaultBody(PlatformSmsType::InvoiceIssued, 'en'), 2)->assertOk()->assertJsonPath('data.is_custom', false)->assertJsonPath('data.revision', 0);
        $this->assertSame(0, $this->platformTable('platform_sms_templates')->count());

        $put('Custom {invoice_no} {link}', 0)->assertOk();
        $this->admin('DELETE', 'message-types/invoice_issued/templates/en')->assertOk()->assertJsonPath('data.is_custom', false);
        $this->admin('DELETE', 'message-types/invoice_issued/templates/en')->assertOk(); // idempotent
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms_template.reset')->count());
        $this->assertSame(4, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms_template.updated')->count());
    }

    public function test_preview_and_test_sends(): void
    {
        $this->admin('POST', 'message-types/preview', ['type' => 'welcome', 'language' => 'en', 'body' => 'Hi {merchant_name} of {store_name}: {link}'])->assertOk()
            ->assertJsonPath('data.text', 'Hi Nasrin of Mugdho Fashion: http://localhost:5183/settings/plan')->assertJsonPath('data.parts', 1)
            ->assertJsonPath('data.encoding', 'gsm7');
        $this->admin('POST', 'message-types/preview', ['type' => 'sign_in_code', 'language' => 'en', 'body' => '{otp}'])->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_type_locked');
        $this->admin('POST', 'message-types/preview', ['type' => 'welcome', 'language' => 'en', 'body' => '{otp}'])->assertStatus(422);

        $this->admin('POST', 'message-types/welcome/test', ['language' => 'bn', 'phone' => '01711552211'])->assertOk()
            ->assertJsonPath('data.status', 'sent')->assertJsonPath('data.to_masked', '01711-•••211')->assertJsonPath('data.provider.name', 'Fake driver (tests)');
        $this->assertStringStartsWith('Store Plix-এ স্বাগতম, নাসরিন!', $this->fake()->sent[0]['text']);
        $this->admin('POST', 'message-types/password_reset_code/test', ['language' => 'bn', 'phone' => '01711552211'])->assertOk();
        $this->assertSame('Your Store Plix code is 482913. Valid for 5 minutes. Do not share it.', $this->fake()->sent[1]['text']);
        $this->assertSame('security', $this->fake()->routes[1]);
        $rows = $this->platformQuery(SmsMessage::class)->where('purpose', 'platform_test')->orderBy('created_at')->get();
        $this->assertCount(2, $rows);
        $this->assertNull($rows->firstWhere('template', 'platform:test.security')->body_preview); // code texts never stored
        $this->admin('POST', 'message-types/broadcast/test', ['language' => 'bn', 'phone' => '01711552211'])->assertStatus(422);
        $this->admin('POST', 'message-types/welcome/test', ['language' => 'en', 'phone' => '01711552211', 'body' => 'Hey {coupon}'])->assertStatus(422);
        $this->assertSame(2, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms.test_sent')->count());
    }
}
