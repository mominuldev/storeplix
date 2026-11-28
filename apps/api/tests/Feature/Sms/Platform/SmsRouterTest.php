<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Identity\Otp\OtpPurpose;
use App\Domain\Identity\Otp\OtpService;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Jobs\SendPlatformSms;
use App\Domain\Sms\Jobs\SendSms;
use App\Domain\Sms\Mail\PlatformSmsMail;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Platform\PlatformSmsNotifier;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\Routing\RoutingSmsGateway;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §4.3–§4.5 router vectors (S225): env bootstrap byte for byte, primary ok, `unavailable` → the failover in
 * the same call, `timeout` → no second try + breaker open, `rejected` → no count, n failures open the breaker,
 * half-open after 5 min (time travel) closes on success, groups filter, promotional mask pending → `no_route`, masked
 * shop sender never on the failover, SMS_DRIVER=fake never routes to a database provider, retry windows 30 / 5 min.
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class SmsRouterTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    private int $reveCalls = 0;

    private int $httpCalls = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
        Mail::fake();
    }

    private function gateway(): SmsGateway
    {
        return app(SmsGateway::class);
    }

    /** Primary REVE + HTTP failover; `$reve` / `$http` decide each call's outcome ('ok' | 'down' | 'timeout' | 'reject' | 'auth'). */
    private function pair(string &$reve, string &$http, array $primaryOver = []): array
    {
        $this->useRouter();
        $answer = function (string $mode, string $okBody) {
            return match ($mode) {
                'down' => Http::response('Service Unavailable', 503),
                'timeout' => throw new ConnectionException('cURL error 28: Operation timed out after 10001 milliseconds with 0 bytes received'),
                'reject' => Http::response(['Status' => '1007', 'Text' => 'Invalid number']),
                'auth' => Http::response(['Status' => '109', 'Text' => 'Invalid credentials'], 200),
                default => Http::response(json_decode($okBody, true)),
            };
        };
        $this->httpFake(function (Request $r) use (&$reve, &$http, $answer) {
            if (str_contains($r->url(), 'api.reve.example')) {
                if (str_ends_with($r->url(), '/getbalance')) {
                    return Http::response(['Status' => '0', 'Balance' => '9000']);
                }
                $this->reveCalls++;

                return $answer($reve, '{"Status":"0","Message_ID":"R-1"}');
            }
            if (str_contains($r->url(), 'alpha.example')) {
                $this->httpCalls++;

                return $answer($http === 'reject' ? 'ok-reject' : $http, '{"response_code":202,"data":{"request_id":"H-1"}}');
            }

            return Http::response(['Status' => '0', 'Message_ID' => 'ENV-1']);
        });
        $saveR = $reve;
        $saveH = $http;
        $reve = $http = 'ok';
        $primary = $this->activeProvider($this->reveInput($primaryOver));
        $failover = $this->activeProvider($this->httpInput(['message_groups' => ['shop', 'registration', 'billing', 'security']]), 'failover');
        [$reve, $http] = [$saveR, $saveH];
        $this->reveCalls = $this->httpCalls = 0;

        return [$primary, $failover];
    }

    public function test_no_database_provider_sends_exactly_as_8_9a_through_the_env_account(): void
    {
        $this->useRouter();
        $this->httpFake(['*' => Http::response(['Status' => '0', 'Message_ID' => 77881])]);
        $result = $this->gateway()->send('8801711111111', 'Hello', null, SmsRoute::Shop);
        $this->assertSame('77881', $result->message_id);
        $this->assertNull($result->provider_id);
        Http::assertSent(fn (Request $r) => $r->url() === 'https://smpp.env-reve.example:7790/sendtext'
            && $r->data() === ['apikey' => 'ENV-API-KEY-0001', 'secretkey' => 'ENV-SECRET-KEY-0002', 'callerID' => 'StorePlix', 'toUser' => '8801711111111', 'messageContent' => 'Hello']);
        // A shop's masked sender on the env primary.
        $this->gateway()->send('8801711111111', 'Masked', 'GlowBD');
        Http::assertSent(fn (Request $r) => $r['messageContent'] === 'Masked' && $r['callerID'] === 'GlowBD');

        // No env keys and no database provider: no_route.
        $this->useRouter(env: false);
        try {
            $this->gateway()->send('8801711111111', 'x');
            $this->fail('expected no_route');
        } catch (SmsSendFailed $e) {
            $this->assertSame('no_route', $e->errorCode());
        }
    }

    public function test_sms_driver_fake_never_routes_to_a_database_provider(): void
    {
        $reve = $http = 'ok';
        $this->pair($reve, $http);
        config(['sms.driver' => 'fake']);
        $this->app->forgetInstance(SmsGateway::class);
        $this->assertInstanceOf(FakeSmsGateway::class, $this->gateway());
        $this->gateway()->send('8801711111111', 'to the fake');
        $this->assertSame(0, $this->reveCalls + $this->httpCalls);
        $this->assertSame('to the fake', $this->fake()->sent[0]['text']);
    }

    public function test_primary_ok_and_unavailable_goes_to_the_failover_in_the_same_call(): void
    {
        $reve = $http = 'ok';
        [$primary, $failover] = $this->pair($reve, $http);
        $r = $this->gateway()->send('8801711111111', 'one', 'GlowBD');
        $this->assertSame($primary, $r->provider_id);
        $this->assertNull($r->failover_error_code);
        Http::assertSent(fn (Request $q) => ($q->data()['messageContent'] ?? null) === 'one' && ($q->data()['callerID'] ?? null) === 'GlowBD'); // masked sender on the primary

        $reve = 'down';
        $r = $this->gateway()->send('8801711111111', 'two', 'GlowBD');
        $this->assertSame($failover, $r->provider_id);
        $this->assertSame('provider_unavailable', $r->failover_error_code);
        $this->assertSame([1, 1], [$this->reveCalls - 1, $this->httpCalls]);
        // S225 / P89B-9: the masked shop sender never reaches the failover (its default sender is used).
        Http::assertSent(fn (Request $q) => str_contains($q->url(), 'alpha.example') && ($q->data()['msg'] ?? null) === 'two' && ($q->data()['sender_id'] ?? null) === 'Storeplix');

        // Auth failures fail over too.
        $reve = 'auth';
        $this->assertSame($failover, $this->gateway()->send('8801711111111', 'three')->provider_id);
    }

    public function test_timeout_is_never_retried_and_opens_the_breaker(): void
    {
        $reve = $http = 'ok';
        [$primary, $failover] = $this->pair($reve, $http);
        $reve = 'timeout';
        try {
            $this->gateway()->send('8801711111111', 'maybe accepted');
            $this->fail('expected a timeout');
        } catch (SmsSendFailed $e) {
            $this->assertSame('timeout', $e->reason);
            $this->assertSame('provider_timeout', $e->errorCode());
            $this->assertSame($primary, $e->providerId);
        }
        $this->assertSame(1, $this->reveCalls);
        $this->assertSame(0, $this->httpCalls); // no second provider for the same message
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.failover_started')->count());
        Mail::assertQueued(PlatformSmsMail::class, fn (PlatformSmsMail $m) => $m->kind === PlatformSmsMail::FAILOVER_STARTED);

        // While open, the next message goes straight to the failover.
        $reve = 'ok';
        $this->assertSame($failover, $this->gateway()->send('8801711111111', 'next')->provider_id);
        $this->assertSame(1, $this->reveCalls);
        $this->admin('GET', 'providers')->assertJsonPath('data.failover_active', true)->assertJsonPath('data.primary.health', 'failed_over');
        $this->assertSame('failover_active', $this->admin('GET', 'alerts')->json('data.0.code'));

        // Half-open after 5 minutes without a failure: the primary is probed; success closes the breaker.
        $this->travel(4)->minutes();
        $this->assertSame($failover, $this->gateway()->send('8801711111111', 'still failover')->provider_id);
        $this->travel(2)->minutes();
        $this->assertSame($primary, $this->gateway()->send('8801711111111', 'probe')->provider_id);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.failover_ended')->count());
        $this->admin('GET', 'providers')->assertJsonPath('data.failover_active', false)->assertJsonPath('data.primary.health', 'healthy');
    }

    public function test_n_consecutive_failures_open_the_breaker_and_rejections_do_not_count(): void
    {
        $reve = $http = 'ok';
        [$primary, $failover] = $this->pair($reve, $http, ['failover_after_failures' => 3]);
        $reve = 'reject';
        for ($i = 0; $i < 4; $i++) {
            try {
                $this->gateway()->send('8801711111111', 'bad number');
                $this->fail('expected rejected');
            } catch (SmsSendFailed $e) {
                $this->assertSame('rejected', $e->reason);
            }
        }
        $this->assertSame(0, $this->httpCalls); // a rejection never goes to the failover
        $this->admin('GET', 'providers')->assertJsonPath('data.primary.health', 'healthy')->assertJsonPath('data.failover_active', false); // rejections not counted; the activation test send counts as a success

        $reve = 'down';
        $this->gateway()->send('8801711111111', 'a');
        $this->gateway()->send('8801711111111', 'b');
        $this->admin('GET', 'providers')->assertJsonPath('data.primary.health', 'failing')->assertJsonPath('data.failover_active', false);
        $this->gateway()->send('8801711111111', 'c');
        $this->admin('GET', 'providers')->assertJsonPath('data.failover_active', true);
        $calls = $this->reveCalls;
        $this->gateway()->send('8801711111111', 'd');
        $this->assertSame($calls, $this->reveCalls); // skipped while open
    }

    public function test_groups_filter_and_promotional_needs_an_approved_mask(): void
    {
        $reve = $http = 'ok';
        [$primary] = $this->pair($reve, $http, ['promotional_sender_status' => 'pending']);
        // promotional: only the primary carries it, its mask is pending → no_route.
        try {
            $this->gateway()->send('8801711111111', 'offer', null, SmsRoute::Promotional);
            $this->fail('expected no_route');
        } catch (SmsSendFailed $e) {
            $this->assertSame('no_route', $e->errorCode());
        }
        $this->assertSame(0, $this->reveCalls + $this->httpCalls);

        $this->admin('PATCH', "providers/{$primary}", ['revision' => $this->provider($primary)->revision, 'promotional_sender_status' => 'approved'])->assertOk();
        $this->assertSame($primary, $this->gateway()->send('8801711111111', 'offer', null, SmsRoute::Promotional)->provider_id);
        Http::assertSent(fn (Request $q) => ($q->data()['messageContent'] ?? null) === 'offer' && ($q->data()['callerID'] ?? null) === 'StorePlixP');

        // The failover doesn't carry promotional: a down primary means no promotional route.
        $reve = 'down';
        $this->expectException(SmsSendFailed::class);
        $this->gateway()->send('8801711111111', 'offer 2', null, SmsRoute::Promotional);
    }

    public function test_router_promotional_slot_respects_the_rate_limit(): void
    {
        $reve = $http = 'ok';
        [$primary] = $this->pair($reve, $http, ['rate_limit_per_minute' => 2]);
        /** @var RoutingSmsGateway $router */
        $router = $this->gateway();
        $this->assertSame(0, $router->promotionalSlot()['wait']);
        $router->send('8801711111111', 'code 1', null, SmsRoute::Security);
        $router->send('8801711111111', 'code 2', null, SmsRoute::Security); // codes count but are never delayed
        $router->send('8801711111111', 'code 3', null, SmsRoute::Security);
        $this->assertSame($primary, $router->promotionalSlot()['route']?->id);
        $this->assertGreaterThan(0, $router->promotionalSlot()['wait']);
    }

    public function test_account_codes_are_platform_rows_with_a_five_minute_window(): void
    {
        [$user, $tenant] = $this->merchant();
        $this->useRouter(env: false); // nothing can send
        Bus::fake([SendSms::class]);
        $code = app(OtpService::class)->send('8801711552211', OtpPurpose::Login, '127.0.0.1', true, $tenant->id);
        $row = $this->platformQuery(SmsMessage::class)->sole();
        $this->assertNull($row->tenant_id);
        $this->assertSame($tenant->id, $row->merchant_tenant_id);
        $this->assertSame('sign_in_code', $row->platform_type);
        $this->assertSame(1, $row->parts);
        $this->assertNull($row->body_preview);
        Bus::assertDispatched(SendSms::class, fn (SendSms $j) => $j->route === 'security' && $j->text === "Your Store Plix code is {$code}. Valid for 5 minutes. Do not share it.");

        // Provider-level failure → queued + a delayed retry; after 5 minutes → failed / provider_unavailable.
        (new SendSms($row->id, 'Your Store Plix code is 123456. Valid for 5 minutes. Do not share it.', 'security'))->handle($this->gateway());
        $this->assertSame('queued', $row->refresh()->status);
        $this->assertSame('no_route', $row->error_code);
        Bus::assertDispatched(SendSms::class, fn (SendSms $j) => $j->attempt === 1);
        $this->travel(6)->minutes();
        (new SendSms($row->id, 'x', 'security', 1))->handle($this->gateway());
        $this->assertSame('failed', $row->refresh()->status);
        $this->assertSame('provider_unavailable', $row->error_code);
    }

    public function test_platform_sms_retry_for_thirty_minutes_and_a_timeout_is_final(): void
    {
        $reve = $http = 'down';
        $this->pair($reve, $http);
        [$owner, $tenant] = $this->owner('alpha');
        Bus::fake([SendPlatformSms::class]);
        $message = app(PlatformSmsNotifier::class)->send(PlatformSmsType::PaymentReceived, $owner,
            ['invoice_no' => 'SP-1', 'amount' => '1,770', 'plan' => 'Growth'], $tenant->id);
        $this->assertNotNull($message);
        $job = fn (int $attempt) => new SendPlatformSms($message->id, 'text', 'payment_received', $attempt);
        $job(0)->handle($this->gateway());
        $this->assertSame('queued', $message->refresh()->status);
        $this->travel(20)->minutes();
        $job(3)->handle($this->gateway());
        $this->assertSame('queued', $message->refresh()->status);
        $this->travel(11)->minutes();
        $job(4)->handle($this->gateway());
        $this->assertSame('failed', $message->refresh()->status);
        $this->assertSame('provider_unavailable', $message->error_code);

        // A timeout: failed at once, never re-dispatched.
        Bus::fake([SendPlatformSms::class]);
        $reve = 'timeout';
        $this->travel(10)->minutes(); // breakers half-open
        $second = app(PlatformSmsNotifier::class)->send(PlatformSmsType::PaymentReceived, $owner,
            ['invoice_no' => 'SP-2', 'amount' => '1,770', 'plan' => 'Growth'], $tenant->id);
        (new SendPlatformSms($second->id, 'text', 'payment_received'))->handle($this->gateway());
        $this->assertSame('failed', $second->refresh()->status);
        $this->assertSame('provider_timeout', $second->error_code);
        Bus::assertDispatchedTimes(SendPlatformSms::class, 1); // only the notifier's own dispatch
    }

    public function test_shop_sms_store_the_carrying_provider(): void
    {
        $reve = $http = 'ok';
        [$primary, $failover] = $this->pair($reve, $http);
        $row = SmsMessage::query()->create(['tenant_id' => null, 'to' => '8801711111111', 'purpose' => 'sms_test', 'template' => 't', 'status' => 'queued']);
        $row->markSent('x', $this->gateway()->send('8801711111111', 'x'));
        $this->assertSame($primary, $row->refresh()->provider_id);
        $reve = 'down';
        $http = 'down';
        try {
            $this->gateway()->send('8801711111111', 'y');
        } catch (SmsSendFailed $e) {
            $row->markFailed('down', $e);
        }
        $this->assertSame($failover, $row->refresh()->provider_id);
        $this->assertSame('provider_unavailable', $row->error_code);
    }
}
