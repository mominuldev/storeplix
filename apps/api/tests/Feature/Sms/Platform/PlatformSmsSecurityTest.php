<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Sms\Broadcasts\Jobs\SendPlatformBroadcastBatch;
use App\Domain\Sms\Broadcasts\Jobs\StartPlatformBroadcast;
use App\Domain\Sms\Jobs\SendPlatformSms;
use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\Providers\SmsEndpointGuard;
use App\Domain\Sms\SmsServiceProvider;
use Illuminate\Foundation\Testing\RefreshDatabase;
use LogicException;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

/**
 * PHASE-8-9B S220 (connections never serialised, debug output redacted, job payloads carry ids only), S224 (SSRF
 * matrix), S231 (the HTTP fake refuses to boot in production) and the static arch test: every SMS a provider sends goes
 * through the router (or the provider test / rotation / balance read in Providers) — nothing else touches a driver.
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class PlatformSmsSecurityTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    public function test_connections_redact_and_never_serialise(): void
    {
        $c = new SmsConnection(['api_key' => 'TOPSECRET-123', 'secret_key' => 'OTHER-SECRET-9'], ['base_url' => 'https://x.example'], 10, 'p1');
        $this->assertStringNotContainsString('TOPSECRET-123', print_r($c, true));
        $this->assertStringNotContainsString('TOPSECRET-123', var_export($c->__debugInfo(), true));
        $this->assertSame('bad [redacted] and [redacted]', $c->redact('bad TOPSECRET-123 and '.rawurlencode('OTHER-SECRET-9')));
        $this->expectException(LogicException::class);
        serialize($c);
    }

    public function test_job_payloads_carry_no_credentials(): void
    {
        $this->setUpPlatformSms();
        $this->reveOk();
        $this->activeProvider($this->reveInput());
        foreach ([new SendPlatformSms('01jz0000000000000000000000', 'Hello', 'welcome'), new StartPlatformBroadcast('01jz0000000000000000000000'),
            new SendPlatformBroadcastBatch('01jz0000000000000000000000')] as $job) {
            $payload = serialize($job);
            $this->assertStringNotContainsString(self::API_KEY, $payload);
            $this->assertStringNotContainsString(self::SECRET_KEY, $payload);
        }
    }

    public function test_ssrf_matrix(): void
    {
        $this->setUpPlatformSms();
        foreach (['https://169.254.169.254/latest', 'https://[::1]/x', 'https://100.64.0.1', 'https://10.1.2.3', 'https://192.168.0.1', 'https://0.0.0.0',
            'http://api.example', 'https://metadata.google.internal', 'https://printer.local', 'https://localhost:8443', 'ftp://api.example'] as $bad) {
            try {
                SmsEndpointGuard::assertAcceptable($bad);
                $this->fail("{$bad} accepted");
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        foreach (['100.64.0.1', '169.254.169.254', '10.0.0.8', '127.0.0.1', '172.16.0.1', '198.18.0.1'] as $ip) {
            $this->assertFalse(SmsEndpointGuard::isPublicIp($ip), $ip);
        }
        $this->assertTrue(SmsEndpointGuard::isPublicIp('93.184.216.34'));
        $this->assertSame(['api.reve.example:443:93.184.216.34'], app(SmsEndpointGuard::class)->pin('https://api.reve.example/send'));
        $this->expectException(\InvalidArgumentException::class);
        app(SmsEndpointGuard::class)->pin('https://rebind.example/send');
    }

    public function test_the_http_fake_refuses_to_boot_in_production(): void
    {
        config(['sms.providers_http_fake' => true]);
        $this->app['env'] = 'production';
        try {
            SmsServiceProvider::assertSafeConfiguration($this->app);
            $this->fail('SMS_PROVIDERS_HTTP_FAKE booted in production');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('SMS_PROVIDERS_HTTP_FAKE', $e->getMessage());
        } finally {
            $this->app['env'] = 'testing';
        }
        config(['sms.providers_http_fake' => false]);
        $this->app['env'] = 'production';
        SmsServiceProvider::assertSafeConfiguration($this->app);
        $this->app['env'] = 'testing';
        config(['sms.providers_http_fake' => true]);
        SmsServiceProvider::assertSafeConfiguration($this->app); // dev / testing: allowed
        $this->addToAssertionCount(1);
    }

    public function test_canned_driver_answers_without_network_in_dev(): void
    {
        $this->setUpPlatformSms();
        config(['sms.providers_http_fake' => true]);
        $this->httpFake([]); // stray requests would throw
        $id = $this->createProvider($this->reveInput());
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk()->assertJsonPath('data.status', 'passed')
            ->assertJsonPath('data.balance_paisa', 500000);
    }

    /** Static: only the router and the provider lifecycle reach a driver; nothing else builds one or decrypts provider credentials. */
    public function test_all_senders_go_through_the_router(): void
    {
        $allowed = ['#^app/Domain/Sms/Routing/#', '#^app/Domain/Sms/Providers/#', '#^app/Domain/Sms/Drivers/#', '#^app/Domain/Sms/SmsServiceProvider\.php$#'];
        $offenders = [];
        foreach ((new Finder)->files()->name('*.php')->in(base_path('app')) as $file) {
            $path = str_replace(base_path().'/', '', $file->getRealPath());
            $code = $file->getContents();
            $uses = preg_match('/\b(RevesmsDriver|HttpDriver|CannedSmsDriver|SmsDriverFactory|SmsProviderDriver|credentials_encrypted)\b/', $code) === 1;
            if ($uses && array_filter($allowed, fn ($p) => preg_match($p, $path) === 1) === [] && ! str_starts_with($path, 'app/Domain/Sms/Models/SmsProvider.php')) {
                $offenders[] = $path;
            }
        }
        $this->assertSame([], $offenders);
    }
}
