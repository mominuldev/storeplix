<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §8 (P89B-24, S230): platform rows only (never shop SMS), 90 days, `q` phone / shop name, group mapping,
 * masked phones, codes hidden, CSV (BOM, masking, "Code hidden", 50k cap, limiter, audit); the merchant's own log maps
 * the new error codes to `provider_error`.
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class PlatformSmsLogTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
    }

    private function row(array $a): SmsMessage
    {
        $m = new SmsMessage;
        $m->forceFill($a + ['to' => '8801711552211', 'template' => 't', 'status' => 'sent', 'parts' => 1]);
        $m->save();

        return $m;
    }

    public function test_scope_filters_masking_and_hidden_codes(): void
    {
        [$ownerUser, $tenant, $store] = $this->owner('mugdho');
        $code = $this->row(['tenant_id' => null, 'merchant_tenant_id' => $tenant->id, 'purpose' => 'otp_login', 'platform_type' => 'sign_in_code']);
        $invoice = $this->row(['tenant_id' => null, 'merchant_tenant_id' => $tenant->id, 'purpose' => 'platform_invoice_issued', 'platform_type' => 'invoice_issued',
            'to' => '8801811000222', 'body_preview' => 'Store Plix: Invoice SP-1 … Pay: [link]', 'status' => 'failed', 'error_code' => 'provider_timeout']);
        $test = $this->row(['tenant_id' => null, 'purpose' => 'platform_test', 'body_preview' => 'Store Plix SMS test from REVE. No action needed.']);
        $this->inTenant($tenant, fn () => $this->row(['tenant_id' => $tenant->id, 'store_id' => $store->id, 'purpose' => 'order_placed', 'kind' => 'transactional',
            'body_preview' => 'shop SMS', 'status' => 'failed', 'error_code' => 'provider_unavailable']));
        $this->travel(-100)->days();
        $old = $this->row(['tenant_id' => null, 'purpose' => 'platform_welcome', 'platform_type' => 'welcome']);
        $this->travelBack();

        $data = $this->admin('GET', 'messages')->assertOk()->json('data');
        $this->assertSame([$test->id, $invoice->id, $code->id], array_column($data, 'id')); // newest first, no shop row, no >90-day row
        $byId = collect($data)->keyBy('id');
        $this->assertTrue($byId[$code->id]['body_hidden']);
        $this->assertNull($byId[$code->id]['body_preview']);
        $this->assertSame('sign_in_code', $byId[$code->id]['type']);
        $this->assertSame('security', $byId[$code->id]['group']);
        $this->assertSame(['id' => $tenant->id, 'name' => $store->name, 'slug' => $store->slug], $byId[$code->id]['merchant']);
        $this->assertSame('01811-•••222', $byId[$invoice->id]['to_masked']);
        $this->assertSame('provider_timeout', $byId[$invoice->id]['error_code']);
        $this->assertSame('test', $byId[$test->id]['type']);
        $this->assertNull($byId[$test->id]['group']);
        $this->assertSame(['id' => null, 'name' => 'Fake driver (tests)'], $byId[$test->id]['provider']);

        $ids = fn (string $q) => array_column($this->admin('GET', 'messages?'.$q)->assertOk()->json('data'), 'id');
        $this->assertSame([$invoice->id], $ids('filter[q]=01811000222'));
        $this->assertSame([$invoice->id, $code->id], $ids('filter[q]=mugdho'));
        $this->assertSame([$invoice->id], $ids('filter[group]=billing'));
        $this->assertSame([$invoice->id, $code->id], $ids('filter[group]=billing,security'));
        $this->assertSame([$invoice->id], $ids('filter[status]=failed'));
        $this->admin('GET', 'messages?filter[q]=m')->assertStatus(422);
        $this->admin('GET', 'messages?filter[group]=shop')->assertStatus(422);
        $this->admin('GET', 'messages?filter[from]='.now('Asia/Dhaka')->subDays(91)->format('Y-m-d'))->assertStatus(422);
        $this->admin('GET', 'messages?filter[from]='.now('Asia/Dhaka')->format('Y-m-d').'&filter[to]='.now('Asia/Dhaka')->subDay()->format('Y-m-d'))->assertStatus(422);

        // The shop's own log never shows platform rows and maps new codes to provider_error.
        $shop = $this->flushSession()->flushHeaders()->withHeaders($this->tenantHeaders($ownerUser, $tenant))
            ->getJson("/api/v1/stores/{$store->id}/sms/messages")->assertOk()->json('data');
        $this->assertCount(1, $shop);
        $this->assertSame('provider_error', $shop[0]['error_code']);
    }

    public function test_cursor_pagination(): void
    {
        for ($i = 0; $i < 52; $i++) {
            $this->row(['tenant_id' => null, 'purpose' => 'platform_test']);
            $this->travel(1)->seconds();
        }
        $first = $this->admin('GET', 'messages')->assertOk();
        $this->assertCount(50, $first->json('data'));
        $next = $this->admin('GET', 'messages?cursor='.urlencode((string) $first->json('meta.next_cursor')))->assertOk();
        $this->assertCount(2, $next->json('data'));
    }

    public function test_csv_export(): void
    {
        [, $tenant] = $this->owner('mugdho');
        $this->row(['tenant_id' => null, 'merchant_tenant_id' => $tenant->id, 'purpose' => 'otp_login', 'platform_type' => 'sign_in_code']);
        $this->row(['tenant_id' => null, 'purpose' => 'platform_welcome', 'platform_type' => 'welcome', 'body_preview' => '=HYPERLINK("x") hi [link]']);
        $response = $this->admin('GET', 'messages/export?filter[group]=registration,security')->assertOk();
        $this->assertStringStartsWith('text/csv', (string) $response->headers->get('Content-Type'));
        $csv = $response->streamedContent();
        $this->assertStringStartsWith("\xEF\xBB\xBF", $csv);
        $lines = array_map(fn ($l) => str_getcsv($l, escape: ''), array_values(array_filter(explode("\n", substr($csv, 3)))));
        $this->assertSame(['time (Asia/Dhaka)', 'phone (masked)', 'merchant', 'type', 'group', 'message', 'parts', 'status', 'provider', 'error'], $lines[0]);
        $this->assertCount(3, $lines);
        $this->assertSame('01711-•••211', $lines[1][1]);
        $this->assertStringNotContainsString('8801711552211', $csv);
        $this->assertContains('Code hidden', array_column($lines, 5));
        $this->assertContains("'=HYPERLINK(\"x\") hi [link]", array_column($lines, 5));
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'platform_sms.log_exported')->sole();
        $this->assertSame(2, $audit->meta['rows']);
        $this->assertSame(['group' => 'registration,security'], $audit->meta['filters']);

        config(['sms.platform.export_max_rows' => 1]);
        $this->admin('GET', 'messages/export')->assertStatus(422)->assertJsonPath('error.code', 'export_too_large')->assertJsonPath('error.details.max', 1);
        config(['sms.platform.export_max_rows' => 50000]);
        for ($i = 0; $i < 3; $i++) {
            $this->admin('GET', 'messages/export');
        }
        $this->admin('GET', 'messages/export')->assertStatus(429);
    }
}
