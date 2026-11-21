<?php

namespace App\Domain\Sms\Drivers;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * REVE SMS (smpp.revesms.com). JSON POST; credentials in the body only.
 * Accepted when Status == "0" (string or int). Retries ONLY connection errors (2x),
 * so an accepted send is never repeated.
 */
class RevesmsGateway implements SmsGateway
{
    /**
     * @param  array{base_url: string, api_key: ?string, secret_key: ?string, caller_id: ?string, timeout?: int, retries?: int}  $config
     */
    public function __construct(private readonly array $config) {}

    public function send(string $msisdn, string $text): SmsResult
    {
        $payload = $this->post('/sendtext', [
            'apikey' => (string) $this->config['api_key'],
            'secretkey' => (string) $this->config['secret_key'],
            'callerID' => (string) $this->config['caller_id'],
            'toUser' => $msisdn,
            'messageContent' => $text,
        ]);

        $status = $payload['Status'] ?? $payload['status'] ?? null;
        $messageId = $payload['Message_ID'] ?? $payload['message_id'] ?? $payload['MessageId'] ?? null;

        if ((string) $status === '0') {
            return new SmsResult(is_scalar($messageId) ? (string) $messageId : null, true, $payload);
        }

        $text = $this->providerText($payload);
        Log::warning('sms.revesms.rejected', ['to' => Phone::mask($msisdn), 'status' => is_scalar($status) ? $status : null, 'text' => $text]);

        throw new SmsSendFailed("REVE SMS rejected the message: {$text}");
    }

    public function status(string $messageId): array
    {
        return $this->post('/getstatus', [
            'apikey' => (string) $this->config['api_key'],
            'secretkey' => (string) $this->config['secret_key'],
            'messageid' => $messageId,
        ]);
    }

    /**
     * @param  array<string, string>  $body
     * @return array<string, mixed>
     */
    private function post(string $path, array $body): array
    {
        $url = rtrim((string) $this->config['base_url'], '/').$path;

        try {
            /** @var Response $response */
            $response = Http::timeout((int) ($this->config['timeout'] ?? 10))
                ->acceptJson()
                ->asJson()
                ->retry(
                    (int) ($this->config['retries'] ?? 2) + 1,
                    250,
                    fn (Throwable $e) => $e instanceof ConnectionException,
                    throw: false,
                )
                ->post($url, $body);
        } catch (ConnectionException $e) {
            Log::warning('sms.revesms.unreachable', ['path' => $path, 'error' => $this->redact($e->getMessage())]);

            throw new SmsSendFailed('REVE SMS is unreachable.', previous: null);
        }

        $json = $response->json();
        if (is_array($json) && array_is_list($json) && isset($json[0]) && is_array($json[0])) {
            $json = $json[0]; // some endpoints wrap the object in a list
        }

        if (! is_array($json)) {
            $snippet = $this->redact(Str::limit(trim($response->body()), 200));
            Log::warning('sms.revesms.bad_response', ['path' => $path, 'http' => $response->status(), 'body' => $snippet]);

            throw new SmsSendFailed("REVE SMS returned an unexpected response (HTTP {$response->status()}).");
        }

        return $json;
    }

    /** @param  array<string, mixed>  $payload */
    private function providerText(array $payload): string
    {
        $text = $payload['Text'] ?? $payload['text'] ?? $payload['Message'] ?? $payload['message'] ?? 'unknown error';

        return $this->redact(Str::limit(is_scalar($text) ? (string) $text : json_encode($text), 200));
    }

    /** Belt and braces: never let credentials reach a log line. */
    private function redact(string $value): string
    {
        $secrets = array_filter([(string) $this->config['api_key'], (string) $this->config['secret_key']]);

        return $secrets === [] ? $value : str_replace($secrets, '[redacted]', $value);
    }
}
