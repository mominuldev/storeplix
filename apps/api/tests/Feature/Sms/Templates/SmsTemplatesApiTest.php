<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Templates;

use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\Models\SmsTemplate;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Sms\Overview\SmsSliceFixtures;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** PHASE-8-9A §7 (P89A-7, P89A-8, P89A-10, P89A-11, P89A-17; S208, S214): templates list, save, reset, preview. */
#[Group('sms')]
class SmsTemplatesApiTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsSliceFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_list_has_16_rows_with_todays_defaults(): void
    {
        [, , $store, $h] = $this->smsShop();
        $rows = $this->api($h, 'GET', $this->smsUrl($store, '/templates'))->assertOk()->json('data');
        $this->assertCount(16, $rows);
        $this->assertSame(['order_placed', 'order_placed', 'order_confirmed', 'order_confirmed'], array_column(array_slice($rows, 0, 4), 'key'));
        $this->assertSame(['bn', 'en'], array_column(array_slice($rows, 0, 2), 'language'));
        $this->assertSame(['pos_receipt', 'pos_receipt', 'checkout_otp', 'checkout_otp'], array_column(array_slice($rows, 12, 4), 'key'));
        foreach (['bn', 'en'] as $language) {
            $files = require resource_path("sms/{$language}.php");
            foreach ($rows as $row) {
                if ($row['language'] === $language) {
                    $this->assertSame($files[$row['key']], $row['default_body'], $row['key']);
                    $this->assertSame($files[$row['key']], $row['body']);
                }
            }
        }
        $otp = $rows[14];
        $this->assertSame(['checkout_otp', false, null, 'Checkout code', ['shop', 'code'], 0], [$otp['key'], $otp['editable'], $otp['enabled'], $otp['label'], $otp['merge_fields'], $otp['revision']]);
        $this->assertSame([true, false], [$rows[0]['enabled'], $rows[2]['enabled']]); // order_placed on, order_confirmed off by default
        $this->assertNull($rows[12]['enabled']); // pos_receipt: cashier's tick
        $this->assertSame(['url'], $rows[10]['required_fields']); // payment_link
        $this->assertSame('POS receipt', $rows[12]['label']);
        $this->assertStringContainsString('-1042', $rows[2]['preview']['text']);
        $this->assertSame('ucs2', $rows[0]['preview']['encoding']);
        $this->assertSame('gsm7', $rows[1]['preview']['encoding']);
    }

    public function test_save_conflict_default_deletes_and_reset_is_idempotent(): void
    {
        [, $tenant, $store, $h] = $this->smsShop();
        $url = $this->smsUrl($store, '/templates/order_confirmed/bn');
        $saved = $this->api($h, 'PUT', $url, ['body' => "  {shop}: অর্ডার {number} কনফার্ম!\nধন্যবাদ {first_name}  ", 'revision' => 0])->assertOk()
            ->assertJsonPath('data.is_custom', true)->assertJsonPath('data.revision', 1)
            ->assertJsonPath('data.body', '{shop}: অর্ডার {number} কনফার্ম! ধন্যবাদ {first_name}')
            ->assertJsonPath('data.updated_by.id', fn ($id) => is_string($id))->json('data');
        $this->assertNotNull($saved['updated_at']);
        $this->api($h, 'PUT', $url, ['body' => 'Changed {number}', 'revision' => 0])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PUT', $url, ['body' => 'Changed {number}', 'revision' => 1])->assertOk()->assertJsonPath('data.revision', 2);

        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sms_template.updated')->orderBy('created_at')->get();
        $this->assertCount(2, $audit);
        $this->assertStringNotContainsString('Changed', (string) $audit[1]->meta);
        $this->assertSame('sms_template', $audit[0]->subject_type);

        // The default text deletes the custom row.
        $this->api($h, 'PUT', $url, ['body' => SmsTemplates::defaultBody('order_confirmed', 'bn'), 'revision' => 2])->assertOk()
            ->assertJsonPath('data.is_custom', false)->assertJsonPath('data.revision', 0);
        $this->assertSame(0, $this->inTenant($tenant, fn () => SmsTemplate::query()->count()));

        $this->api($h, 'PUT', $url, ['body' => 'Custom {number}'])->assertOk();
        $this->api($h, 'DELETE', $url)->assertOk()->assertJsonPath('data.is_custom', false)
            ->assertJsonPath('data.body', SmsTemplates::defaultBody('order_confirmed', 'bn'));
        $this->api($h, 'DELETE', $url)->assertOk();
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sms_template.reset')->count());
    }

    public function test_body_rules_on_save_and_preview(): void
    {
        [, , $store, $h] = $this->smsShop();
        $put = fn (string $key, string $body) => $this->api($h, 'PUT', $this->smsUrl($store, "/templates/{$key}/en"), ['body' => $body]);
        $preview = fn (string $key, string $body) => $this->api($h, 'POST', $this->smsUrl($store, '/templates/preview'), ['key' => $key, 'language' => 'en', 'body' => $body]);
        foreach ([$put, $preview] as $call) {
            $call('order_placed', 'Hi {name} {order_no}')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_unknown_merge_field')
                ->assertJsonPath('error.details.fields', ['name', 'order_no']);
            $call('order_cancelled', 'Track {track_url}')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_unknown_merge_field');
            $call('payment_link', 'Pay {amount} now')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_missing_merge_field')
                ->assertJsonPath('error.details.fields', ['url']);
            $call('order_placed', 'Visit https://evil.example now')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_link_not_allowed');
            $call('order_placed', 'Visit www.evil.example')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_link_not_allowed');
            $call('order_placed', str_repeat('€', 240))->assertStatus(422)->assertJsonPath('error.code', 'sms_template_too_long')
                ->assertJsonPath('error.details.max_parts', 3);
            $call('order_placed', str_repeat('a', 481))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
            $call('order_placed', '   ')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
            $call('checkout_otp', 'Code {code}')->assertStatus(422)->assertJsonPath('error.code', 'sms_template_read_only');
        }
        $this->api($h, 'DELETE', $this->smsUrl($store, '/templates/checkout_otp/en'))->assertStatus(422)->assertJsonPath('error.code', 'sms_template_read_only');
        $this->api($h, 'PUT', $this->smsUrl($store, '/templates/nope/en'), ['body' => 'x'])->assertNotFound();
        $this->api($h, 'PUT', $this->smsUrl($store, '/templates/order_placed/fr'), ['body' => 'x'])->assertNotFound();

        $preview('payment_link', '{shop}: Pay Tk {amount} for {number}: {url}')->assertOk()
            ->assertJsonPath('data.encoding', 'gsm7')->assertJsonPath('data.parts', 1)
            ->assertJsonPath('data.text', fn ($t) => str_contains($t, 'Pay Tk 500 for') && str_contains($t, '/pay/Ab12Cd34Ef56'));
        $this->assertSame(0, $this->inTenantCount($store));
    }

    #[Group('security')]
    public function test_permissions_admin_can_edit_staff_cannot(): void
    {
        [, $tenant, $store] = $this->smsShop();
        [, $ha] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->api($ha, 'PUT', $this->smsUrl($store, '/templates/order_placed/en'), ['body' => 'Hi {first_name}'])->assertOk();
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($hs, 'GET', $this->smsUrl($store, '/templates'))->assertForbidden();
        $this->api($hs, 'PUT', $this->smsUrl($store, '/templates/order_placed/en'), ['body' => 'Hi'])->assertForbidden();
        $this->api($hs, 'POST', $this->smsUrl($store, '/templates/preview'), ['key' => 'order_placed', 'language' => 'en', 'body' => 'Hi'])->assertForbidden();
    }

    #[Group('security')]
    #[Group('tenancy')]
    public function test_custom_template_is_sent_and_masked_sender_drops_the_prefix(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->smsShop('shopa');
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['notifications' => ['sms_language' => 'en']])->assertOk();
        $this->api($h, 'PUT', $this->smsUrl($store, '/templates/order_placed/en'), ['body' => '{shop}: Thanks {first_name}! Order {number} is in.'])->assertOk();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id));
        $this->assertCount(1, $this->sent());
        $this->assertMatchesRegularExpression('/^Shopa\w* Store: Thanks \w+! Order [A-Z]+-\d+ is in\.$/', $this->sent()[0]['text']);
        $this->assertNull($this->sent()[0]['sender_id']);

        // Masked sender: same template without "{shop}: ", the caller ID is the approved one.
        $this->senderRow($tenant, $store, 'ShopaBD');
        $id2 = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        dispatch((new SendOrderSms($id2, 'order_placed'))->forTenant($tenant->id));
        $this->assertMatchesRegularExpression('/^Thanks \w+! Order [A-Z]+-\d+ is in\.$/', $this->sent()[1]['text']);
        $this->assertSame('ShopaBD', $this->sent()[1]['sender_id']);
        $this->api($h, 'GET', $this->smsUrl($store, '/templates'))->assertOk()
            ->assertJsonPath('data.3.preview.text', 'Order SH-1042 is confirmed.');

        // Store B (another tenant) still renders the default text: a custom template never crosses stores.
        [, $tenantB, $storeB, $hB] = $this->smsShop('shopb');
        $this->api($hB, 'PATCH', "/api/v1/stores/{$storeB->id}/settings", ['notifications' => ['sms_language' => 'en']])->assertOk();
        [, $variantB] = $this->stocked($hB, $storeB, 1000, 50);
        $idB = $this->manual($hB, $storeB, $this->manualBody($variantB, 1, ['notify_customer' => false]))->json('data.id');
        dispatch((new SendOrderSms($idB, 'order_placed'))->forTenant($tenantB->id));
        $this->assertStringContainsString(': Order ', $this->sent()[2]['text']);
        $this->assertStringContainsString('received. Total Tk', $this->sent()[2]['text']);
        $this->assertStoreIsolation(SmsTemplate::class, $tenant, $store, $storeB);
    }

    private function inTenantCount($store): int
    {
        return $this->inTenant($store->tenant_id, fn () => SmsTemplate::query()->where('store_id', $store->id)->count());
    }
}
