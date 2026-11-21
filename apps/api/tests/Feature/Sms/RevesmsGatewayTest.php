<?php

namespace Tests\Feature\Sms;

use App\Domain\Sms\Drivers\RevesmsGateway;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('security')]
class RevesmsGatewayTest extends TestCase
{
    private function gateway(): RevesmsGateway
    {
        return new RevesmsGateway([
            'base_url' => 'https://smpp.revesms.test:7790/',
            'api_key' => 'API-KEY-XYZ',
            'secret_key' => 'SECRET-KEY-XYZ',
            'caller_id' => 'StorePlix',
            'timeout' => 10,
            'retries' => 2,
        ]);
    }

    public function test_accepted_send_posts_json_with_credentials_in_body_only(): void
    {
        Http::fake(['smpp.revesms.test:7790/sendtext' => Http::response(['Status' => '0', 'Text' => 'ACCEPTD', 'Message_ID' => 77881])]);

        $result = $this->gateway()->send('8801711111111', 'Hello');

        $this->assertTrue($result->accepted);
        $this->assertSame('77881', $result->message_id);
        Http::assertSentCount(1);
        Http::assertSent(fn (Request $r) => $r->method() === 'POST'
            && $r->url() === 'https://smpp.revesms.test:7790/sendtext'
            && ! str_contains($r->url(), 'KEY')
            && $r->isJson()
            && $r->data() === ['apikey' => 'API-KEY-XYZ', 'secretkey' => 'SECRET-KEY-XYZ', 'callerID' => 'StorePlix', 'toUser' => '8801711111111', 'messageContent' => 'Hello']);
    }

    public function test_integer_status_zero_is_accepted(): void
    {
        Http::fake(['*' => Http::response(['Status' => 0, 'Message_ID' => 'abc'])]);

        $this->assertTrue($this->gateway()->send('8801711111111', 'x')->accepted);
    }

    public function test_rejected_send_throws_and_logs_provider_text_without_secrets(): void
    {
        Http::fake(['*' => Http::response(['Status' => '109', 'Text' => 'Invalid credentials for SECRET-KEY-XYZ'])]);
        $logged = [];
        Log::listen(function ($event) use (&$logged) {
            $logged[] = $event->message.' '.json_encode($event->context);
        });

        try {
            $this->gateway()->send('8801711111111', 'x');
            $this->fail('Expected SmsSendFailed');
        } catch (SmsSendFailed $e) {
            $this->assertStringNotContainsString('SECRET-KEY-XYZ', $e->getMessage());
        }

        Http::assertSentCount(1); // a provider rejection is never retried
        $this->assertNotEmpty($logged);
        foreach ($logged as $line) {
            $this->assertStringNotContainsString('SECRET-KEY-XYZ', $line);
            $this->assertStringNotContainsString('API-KEY-XYZ', $line);
        }
    }

    public function test_garbage_response_throws(): void
    {
        Http::fake(['*' => Http::response('<html>502 Bad Gateway</html>', 502)]);

        $this->expectException(SmsSendFailed::class);
        $this->gateway()->send('8801711111111', 'x');
    }

    public function test_timeout_is_retried_twice_then_fails(): void
    {
        $attempts = 0;
        Http::fake(function () use (&$attempts) {
            $attempts++;
            throw new ConnectionException('cURL error 28: Operation timed out');
        });

        try {
            $this->gateway()->send('8801711111111', 'x');
            $this->fail('Expected SmsSendFailed');
        } catch (SmsSendFailed) {
            $this->assertSame(3, $attempts); // 1 + 2 retries
        }
    }

    public function test_status_lookup(): void
    {
        Http::fake(['*/getstatus' => Http::response(['Status' => '0', 'Text' => 'DELIVRD'])]);

        $this->assertSame('DELIVRD', $this->gateway()->status('77881')['Text']);
        Http::assertSent(fn (Request $r) => $r->data() === ['apikey' => 'API-KEY-XYZ', 'secretkey' => 'SECRET-KEY-XYZ', 'messageid' => '77881']);
    }
}
