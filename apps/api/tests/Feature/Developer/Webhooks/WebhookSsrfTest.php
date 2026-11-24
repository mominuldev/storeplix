<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Developer\Webhooks\Sending\UrlNotAllowed;
use App\Domain\Developer\Webhooks\Sending\WebhookUrlGuard;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

/**
 * S107 (PHASE-8-4 §4.3, SECURITY T14): webhook URLs to local, private, link-local, metadata, IPv6 loopback/ULA hosts, names
 * resolving to private IPs, internal ports, credentials, plain http (and http in production) are refused on save (422
 * webhook_url_not_allowed) and again at send time (DNS rebinding → url_not_allowed); redirects are never followed.
 */
#[Group('developer-api')]
#[Group('security')]
class WebhookSsrfTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, WebhookFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWebhooks();
        $this->dns->map += [
            'internal.example.com' => ['10.1.2.3'],
            'mixed.example.com' => ['93.184.216.40', '192.168.1.10'],
            'meta.example.com' => ['169.254.169.254'],
            'v6local.example.com' => ['fd00::5'],
            'v6public.example.com' => ['2606:2800:220:1:248:1893:25c8:1946'],
            'cgnat.example.com' => ['100.64.3.4'],
        ];
    }

    public function test_refused_on_save(): void
    {
        [, , $store, $h] = $this->growthShop();
        foreach ([
            'http://hooks.example.com/x',
            'https://localhost/x',
            'https://app.localhost/x',
            'https://127.0.0.1/x',
            'https://10.0.0.8/x',
            'https://172.16.5.4/x',
            'https://192.168.0.1/x',
            'https://169.254.169.254/latest/meta-data',
            'https://100.64.0.1/x',
            'https://0.0.0.0/x',
            'https://[::1]/x',
            'https://[fd00::1]/x',
            'https://[fe80::1]/x',
            'https://[::ffff:127.0.0.1]/x',
            'https://224.0.0.1/x',
            'https://metadata.google.internal/x',
            'https://internal.example.com/x',
            'https://mixed.example.com/x',
            'https://meta.example.com/x',
            'https://v6local.example.com/x',
            'https://cgnat.example.com/x',
            'https://unknown.example.com/x',
            'https://2130706433/x',
            'https://0x7f000001/x',
            'https://hooks.example.com:22/x',
            'https://hooks.example.com:80/x',
            'https://hooks.example.com:6379/x',
            'https://hooks.example.com:5432/x',
            'https://user:pass@hooks.example.com/x',
            'ftp://hooks.example.com/x',
            'hooks.example.com/x',
        ] as $url) {
            $this->addEndpoint($h, $store, ['order.created'], $url)->assertStatus(422)->assertJsonPath('error.code', 'webhook_url_not_allowed');
        }

        foreach (['https://hooks.example.com:8443/x', 'https://v6public.example.com/x', 'https://93.184.216.34/x'] as $url) {
            $this->addEndpoint($h, $store, ['order.created'], $url)->assertCreated();
        }
    }

    public function test_http_only_with_the_flag_and_never_in_production(): void
    {
        $guard = app(WebhookUrlGuard::class);
        config(['webhooks_out.allow_http' => true]);
        $this->assertSame('http', $guard->check('http://hooks.example.com/x')->scheme);
        $this->assertSame(80, $guard->check('http://hooks.example.com/x')->port);

        $this->app['env'] = 'production';
        try {
            $guard->check('http://hooks.example.com/x');
            $this->fail('http accepted in production');
        } catch (UrlNotAllowed) {
            $this->assertTrue(true);
        } finally {
            $this->app['env'] = 'testing';
        }
    }

    public function test_rechecked_at_send_time_dns_rebinding_is_refused(): void
    {
        Http::fake(['*' => Http::response('ok', 200)]);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->dns->map['hooks.example.com'] = ['127.0.0.1']; // the name now points inside

        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)
            ->assertJsonPath('data.error_code', 'url_not_allowed')->assertJsonPath('data.status', 'retrying');
        Http::assertNothingSent();
        $this->assertSame('url_not_allowed', $this->deliveriesOf($tenant)->first()->error_code);
    }

    public function test_redirects_are_not_followed(): void
    {
        Http::fake([
            'hooks.example.com/*' => Http::response('', 302, ['Location' => 'http://169.254.169.254/latest/meta-data']),
            '169.254.169.254/*' => Http::response('secret', 200),
        ]);
        [, , $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)
            ->assertJsonPath('data.status', 'retrying')->assertJsonPath('data.response_status', 302)->assertJsonPath('data.error_code', 'http_error');
        Http::assertSentCount(1);
        Http::assertNotSent(fn ($r) => str_contains($r->url(), '169.254.169.254'));
    }

    public function test_public_ip_classification(): void
    {
        foreach (['93.184.216.34', '8.8.8.8', '2606:4700::1111'] as $ip) {
            $this->assertTrue(WebhookUrlGuard::isPublicIp($ip), $ip);
        }
        foreach (['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.127.0.1', '0.0.0.0', '255.255.255.255',
            '224.0.0.251', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'not-an-ip'] as $ip) {
            $this->assertFalse(WebhookUrlGuard::isPublicIp($ip), $ip);
        }
    }
}
