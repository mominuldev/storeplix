<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Log;

use App\Domain\Marketing\Models\Campaign;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Sms\Overview\SmsSliceFixtures;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** PHASE-8-9A §9 (P89A-19 – P89A-21; S208, S209, S217): the 90-day per-store SMS log. */
#[Group('sms')]
#[Group('security')]
class SmsLogApiTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsSliceFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    #[Group('tenancy')]
    public function test_store_rows_only_masked_no_codes_no_account_otps(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->smsShop('shopa');
        [, $tenantB, $storeB] = $this->smsShop('shopb');
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data');

        $mine = $this->smsRow($tenant, $store, ['reference_type' => 'order', 'reference_id' => $order['id'], 'body_preview' => 'Shop: Order received. Track: [link]',
            'created_at' => now()->subMinutes(5)]);
        $otp = $this->smsRow($tenant, $store, ['purpose' => 'checkout_otp', 'template' => 'checkout_otp.bn', 'body_preview' => 'leaked 123456', 'created_at' => now()->subMinutes(4)]);
        $failed = $this->smsRow($tenant, $store, ['status' => 'failed', 'error' => 'REVE SMS rejected: Invalid number 8801711552211', 'error_code' => null,
            'charged_from' => null, 'created_at' => now()->subMinutes(3)]);
        $gone = $this->smsRow($tenant, $store, ['purpose' => 'campaign', 'kind' => null, 'reference_type' => 'campaign',
            'reference_id' => strtolower((string) Str::ulid()), 'created_at' => now()->subMinutes(2)]);
        $this->smsRow($tenant, $store, ['purpose' => 'otp_signup', 'template' => 'otp_signup']); // account code of this tenant
        $this->smsRow(null, null, ['purpose' => 'otp_login', 'template' => 'otp_login']);
        $this->smsRow($tenantB, $storeB); // another tenant
        $this->smsRow($tenant, null); // a tenant row without a store (pre-backfill): never listed
        $this->smsRow($tenant, $store, ['created_at' => now()->subDays(95)]); // outside the 90-day window

        $rows = $this->api($h, 'GET', $this->smsUrl($store, '/messages'))->assertOk()
            ->assertJsonPath('meta.per_page', 50)->assertJsonPath('meta.next_cursor', null)->json('data');
        $this->assertSame([$gone, $failed, $otp, $mine], array_column($rows, 'id'));
        $this->assertSame('01711-•••211', $rows[0]['to_masked']);
        $this->assertSame('marketing', $rows[0]['kind']);
        $this->assertNull($rows[0]['reference']); // deleted / unknown campaign
        $this->assertSame('provider_error', $rows[1]['error_code']);
        $this->assertArrayNotHasKey('error', $rows[1]);
        $this->assertArrayNotHasKey('to', $rows[1]);
        $this->assertNull($rows[2]['body_preview']); // checkout code text never shown
        $this->assertSame(['type' => 'order', 'id' => $order['id'], 'label' => $order['number']], $rows[3]['reference']);
        $this->assertSame('Shop: Order received. Track: [link]', $rows[3]['body_preview']);
        $body = (string) $this->api($h, 'GET', $this->smsUrl($store, '/messages'))->getContent();
        $this->assertStringNotContainsString('8801711552211', $body);
        $this->assertStringNotContainsString('Invalid number', $body);
    }

    public function test_filters_validation_and_cursor(): void
    {
        [, $tenant, $store, $h] = $this->smsShop();
        $campaign = $this->inTenant($tenant, function () use ($store) {
            $c = new Campaign;
            $c->forceFill(['store_id' => $store->id, 'name' => 'Eid sale', 'channel' => 'sms', 'language' => 'en', 'body' => 'Hi', 'status' => 'draft',
                'audience' => ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => false, 'ordered_within_days' => null]]])->save();

            return $c->id;
        });
        foreach (range(1, 55) as $i) {
            $this->smsRow($tenant, $store, ['created_at' => now()->subMinutes(100 - $i)]);
        }
        $c = $this->smsRow($tenant, $store, ['purpose' => 'campaign', 'kind' => 'marketing', 'status' => 'skipped', 'error_code' => 'no_credits',
            'charged_from' => null, 'to' => '8801812345678', 'reference_type' => 'campaign', 'reference_id' => $campaign]);

        $first = $this->api($h, 'GET', $this->smsUrl($store, '/messages'))->assertOk()->assertJsonCount(50, 'data');
        $this->api($h, 'GET', $this->smsUrl($store, '/messages?cursor='.urlencode((string) $first->json('meta.next_cursor'))))->assertOk()->assertJsonCount(6, 'data');

        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[purpose]=campaign,automation&filter[status]=skipped'))->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $c)->assertJsonPath('data.0.error_code', 'no_credits')
            ->assertJsonPath('data.0.reference', ['type' => 'campaign', 'id' => $campaign, 'label' => 'Eid sale']);
        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[phone]=01812-345678'))->assertOk()->assertJsonCount(1, 'data');
        $today = now('Asia/Dhaka')->format('Y-m-d');
        $this->api($h, 'GET', $this->smsUrl($store, "/messages?filter[from]={$today}&filter[to]={$today}"))->assertOk()->assertJsonCount(50, 'data');

        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[phone]=12345'))->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')->assertJsonPath('error.details', fn ($d) => isset($d['filter.phone']));
        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[purpose]=otp_login'))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[status]=delivered'))->assertStatus(422);
        $old = now('Asia/Dhaka')->subDays(91)->format('Y-m-d');
        $this->api($h, 'GET', $this->smsUrl($store, "/messages?filter[from]={$old}"))->assertStatus(422)
            ->assertJsonPath('error.details', fn ($d) => isset($d['filter.from']));
        $this->api($h, 'GET', $this->smsUrl($store, '/messages?filter[from]=2026-13-40'))->assertStatus(422);
    }

    public function test_permissions_and_preview_pruning(): void
    {
        [, $tenant, $store] = $this->smsShop();
        [, $ha] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->api($ha, 'GET', $this->smsUrl($store, '/messages'))->assertOk();
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($hs, 'GET', $this->smsUrl($store, '/messages'))->assertForbidden();

        $old = $this->smsRow($tenant, $store, ['body_preview' => 'old', 'created_at' => now()->subDays(91)]);
        $new = $this->smsRow($tenant, $store, ['body_preview' => 'new']);
        $this->artisan('sms:prune-previews')->assertExitCode(0);
        $this->assertNull($this->platformQuery(SmsMessage::class)->whereKey($old)->value('body_preview'));
        $this->assertSame('new', $this->platformQuery(SmsMessage::class)->whereKey($new)->value('body_preview'));
    }
}
