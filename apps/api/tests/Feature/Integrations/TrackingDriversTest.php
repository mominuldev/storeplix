<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tracking\Drivers\DeliveryResult;
use App\Domain\Tracking\Drivers\Ga4MpDriver;
use App\Domain\Tracking\Drivers\GtmServerDriver;
use App\Domain\Tracking\Drivers\MetaCapiDriver;
use App\Domain\Tracking\Drivers\TiktokEventsDriver;
use App\Domain\Tracking\Models\TrackingEvent;
use App\Domain\Tracking\UserDataHasher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D §5.2 driver contracts with Http::fake (no network): Meta CAPI, GA4 MP (+ validation server), TikTok
 * Events API, GTM server forwarding through PublicEndpointGuard (S334: https/443, public resolution, pinned, DNS rebind),
 * error mapping and redaction of tokens in provider text (S332). Field names are VERIFY items of the contract.
 */
#[Group('integrations')]
#[Group('tracking')]
class TrackingDriversTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
        config(['tracking.fake' => false]);
    }

    /** @param array<string, mixed> $settings @param array<string, string> $secrets */
    private function integration(string $provider, array $settings, array $secrets = []): StoreIntegration
    {
        $row = new StoreIntegration;
        $row->forceFill(['id' => '01jtestintegration000000000', 'store_id' => 's1', 'provider' => $provider, 'settings' => $settings, 'credentials' => $secrets]);

        return $row;
    }

    private function event(string $name, string $providerName, string $id = 'purchase.01order'): TrackingEvent
    {
        $e = new TrackingEvent;
        $e->forceFill(['event_name' => $name, 'provider_event_name' => $providerName, 'event_id' => $id, 'test' => false]);

        return $e;
    }

    /** @return array<string, mixed> */
    private function payload(): array
    {
        return [
            'event_time' => 1_765_000_000, 'event_source_url' => 'https://shop.storeplix.test/orders/thank-you', 'transaction_id' => 'SP-1001',
            'value_amount' => 125050, 'currency' => 'BDT', 'items' => [['id' => 'v1', 'name' => 'Panjabi - L', 'quantity' => 2, 'price_amount' => 62525]],
            'user' => UserDataHasher::forOrder('Rafi@Example.com', '01711000001', 'Rafi Ahmed', 'Dhaka', 'cust1'),
            'client' => ['ip' => '203.0.113.5', 'ua' => 'UA/1', 'fbp' => 'fb.1.1.2', 'fbc' => 'fb.1.1.abc', 'ttclid' => 'tt1', 'ttp' => 'ttp1', 'ga_client_id' => '123.456', 'ga_session_id' => '789'],
            'client_id' => '123.456',
        ];
    }

    public function test_meta_capi_body_hashing_and_error_mapping(): void
    {
        Http::fakeSequence('graph.facebook.com/*')->push(['events_received' => 1])
            ->push(['error' => ['code' => 190, 'message' => 'Error validating access token '.self::META_TOKEN]], 400);
        $i = $this->integration('meta_pixel', ['pixel_id' => self::META_PIXEL], ['access_token' => self::META_TOKEN]);
        $this->assertTrue(app(MetaCapiDriver::class)->send($i, $this->event('purchase', 'Purchase'), $this->payload(), 'TEST123')->delivered);
        Http::assertSent(function (Request $r) {
            $d = $r['data'][0];

            return str_starts_with($r->url(), 'https://graph.facebook.com/v21.0/'.self::META_PIXEL.'/events')
                && $d['event_name'] === 'Purchase' && $d['event_id'] === 'purchase.01order' && $d['action_source'] === 'website'
                && $d['user_data']['em'] === [hash('sha256', 'rafi@example.com')]
                && $d['user_data']['ph'] === [hash('sha256', '8801711000001')] // Meta: digits only
                && $d['user_data']['ct'] === [hash('sha256', 'dhaka')] && $d['user_data']['client_ip_address'] === '203.0.113.5'
                && $d['user_data']['fbp'] === 'fb.1.1.2' && $d['custom_data']['value'] === 1250.5 && $d['custom_data']['currency'] === 'BDT'
                && $d['custom_data']['order_id'] === 'SP-1001' && $r['test_event_code'] === 'TEST123'
                && ! str_contains($r->body(), 'rafi@example.com') && ! str_contains($r->body(), '01711000001');
        });

        $r = app(MetaCapiDriver::class)->send($i, $this->event('purchase', 'Purchase'), $this->payload());
        $this->assertSame([DeliveryResult::AUTH, false], [$r->errorCode, $r->retryable()]);
        $this->assertStringNotContainsString(self::META_TOKEN, (string) $r->providerMessage);
        $this->assertStringContainsString('••••', (string) $r->providerMessage);
    }

    public function test_meta_check_reads_the_pixel_name(): void
    {
        Http::fake(['graph.facebook.com/*' => Http::response(['name' => '<b>My Shop Pixel</b>', 'id' => self::META_PIXEL])]);
        $r = app(MetaCapiDriver::class)->check($this->integration('meta_pixel', ['pixel_id' => self::META_PIXEL], ['access_token' => self::META_TOKEN]));
        $this->assertSame([true, 'My Shop Pixel'], [$r->delivered, $r->foundName]);
        Http::assertSent(fn (Request $r) => str_contains($r->url(), 'fields=name'));
    }

    public function test_ga4_measurement_protocol_and_validation_server(): void
    {
        Http::fake(['www.google-analytics.com/debug/*' => Http::response(['validationMessages' => [['description' => 'Event name is reserved']]]),
            'www.google-analytics.com/*' => Http::response('', 204)]);
        $i = $this->integration('ga4', ['measurement_id' => 'G-ABC123XYZ'], ['api_secret' => self::GA4_SECRET]);
        $this->assertTrue(app(Ga4MpDriver::class)->send($i, $this->event('purchase', 'purchase'), $this->payload())->delivered);
        Http::assertSent(function (Request $r) {
            return str_contains($r->url(), '/mp/collect?measurement_id=G-ABC123XYZ&api_secret=') && $r['client_id'] === '123.456'
                && $r['events'][0]['name'] === 'purchase' && $r['events'][0]['params']['transaction_id'] === 'SP-1001'
                && $r['events'][0]['params']['value'] === 1250.5 && $r['events'][0]['params']['session_id'] === '789'
                && $r['user_data']['sha256_phone_number'] === [hash('sha256', '+8801711000001')] // E.164 with "+"
                && $r['timestamp_micros'] === 1_765_000_000_000_000;
        });
        $debug = app(Ga4MpDriver::class)->send($i, $this->event('purchase', 'purchase'), $this->payload(), null, true);
        $this->assertSame([false, ['Event name is reserved']], [$debug->delivered, $debug->validationMessages]);
    }

    public function test_tiktok_events_api_codes(): void
    {
        $i = $this->integration('tiktok_pixel', ['pixel_id' => self::TIKTOK_PIXEL], ['access_token' => self::TIKTOK_TOKEN]);
        Http::fakeSequence('business-api.tiktok.com/*')->push(['code' => 0, 'message' => 'OK'])->push(['code' => 40105, 'message' => 'Access token invalid'])
            ->push(['code' => 40016, 'message' => 'Too many'])->push(['code' => 51000, 'message' => 'busy']);
        $driver = app(TiktokEventsDriver::class);
        $this->assertTrue($driver->send($i, $this->event('purchase', 'CompletePayment'), $this->payload())->delivered);
        Http::assertSent(fn (Request $r) => $r->hasHeader('Access-Token', self::TIKTOK_TOKEN) && $r['event_source'] === 'web'
            && $r['data'][0]['event'] === 'CompletePayment' && $r['data'][0]['user']['ttclid'] === 'tt1' && $r['data'][0]['user']['email'] === hash('sha256', 'rafi@example.com'));
        $this->assertSame(DeliveryResult::AUTH, $driver->send($i, $this->event('purchase', 'CompletePayment'), $this->payload())->errorCode);
        $this->assertSame([DeliveryResult::RATE_LIMITED, true], [($r = $driver->send($i, $this->event('purchase', 'CompletePayment'), $this->payload()))->errorCode, $r->retryable()]);
        $this->assertSame(DeliveryResult::UNAVAILABLE, $driver->send($i, $this->event('purchase', 'CompletePayment'), $this->payload())->errorCode);
    }

    #[Group('security')]
    public function test_gtm_forwarding_is_pinned_to_a_public_address_and_blocks_dns_rebinding(): void
    {
        Http::fake(['sgtm.example.com/*' => Http::response('', 200)]);
        $i = $this->integration('gtm_server', ['tagging_server_url' => 'https://sgtm.example.com', 'measurement_id' => 'G-ABC123XYZ', 'events' => ['purchase']]);
        $driver = app(GtmServerDriver::class);
        $this->assertTrue($driver->send($i, $this->event('purchase', 'purchase'), $this->payload())->delivered);
        Http::assertSent(fn (Request $r) => $r->url() === 'https://sgtm.example.com/mp/collect?measurement_id=G-ABC123XYZ' && $r['events'][0]['name'] === 'purchase');
        $this->assertTrue($driver->check($i)->delivered);

        // DNS rebind / private resolution between save and send → endpoint_blocked, no request made.
        foreach ([['10.0.0.8'], ['127.0.0.1'], ['169.254.169.254'], ['100.64.1.1'], ['93.184.216.34', '192.168.1.1'], []] as $answer) {
            $this->resolveHosts(['sgtm.example.com' => $answer]);
            Http::fake();
            $this->assertSame(DeliveryResult::BLOCKED, $driver->send($i, $this->event('purchase', 'purchase'), $this->payload())->errorCode);
            $this->assertSame(DeliveryResult::BLOCKED, $driver->check($i)->errorCode);
            Http::assertNothingSent();
        }
    }

    #[Group('security')]
    public function test_gtm_save_with_real_driver_blocks_private_hosts_and_saves_unreachable_with_attention(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('gtmsave');
        $this->planFor($tenant, 'growth');
        $this->resolveHosts(['sgtm.example.com' => ['10.1.2.3']]);
        $this->connect($h, $store, 'gtm_server')->assertUnprocessable()->assertJsonPath('error.code', 'integration_endpoint_blocked');

        $this->resolveHosts(['sgtm.example.com' => ['93.184.216.34']]);
        Http::fakeSequence('sgtm.example.com/*')->push('down', 503)->push('', 302, ['Location' => 'http://169.254.169.254/']);
        $this->connect($h, $store, 'gtm_server')->assertOk()->assertJsonPath('data.status', 'needs_attention')->assertJsonPath('data.attention.0.reason', 'endpoint_unreachable');
        // Redirects are never followed.
        $v = $this->api($h, 'POST', $this->intUrl($store, '/gtm_server/verify'))->assertOk()->json('data.rows');
        $this->assertSame('warn', collect($v)->firstWhere('key', 'endpoint')['state']);
        Http::assertSentCount(2);
    }
}
