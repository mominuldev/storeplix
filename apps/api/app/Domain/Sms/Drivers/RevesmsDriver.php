<?php

declare(strict_types=1);

namespace App\Domain\Sms\Drivers;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Providers\SmsBalance;
use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\Providers\SmsEndpointGuard;
use App\Domain\Sms\Providers\SmsProviderDriver;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use InvalidArgumentException;

/**
 * REVE SMS (smpp.revesms.com), PHASE-8-9B §4.1 (was RevesmsGateway). JSON POST; credentials in the body only.
 * Accepted when Status == "0" (string or int). Reasons: connection refused / DNS / connect timeout / HTTP 5xx / garbage
 * → `unavailable` (connect errors are retried `connectRetries` times: nothing was sent); a read timeout → `timeout`
 * (never retried: REVE may have accepted it); HTTP 401/403 or a credential status → `auth`; any other non-zero Status →
 * `rejected`. Staff-entered endpoints are DNS-pinned (S224); the environment account is trusted config.
 */
final class RevesmsDriver implements SmsProviderDriver
{
    /** REVE statuses that mean "your credentials are wrong / the account is blocked". */
    private const AUTH_STATUSES = ['101', '108', '109', '114'];

    public function __construct(private readonly ?SmsEndpointGuard $guard = null) {}

    public function send(SmsConnection $c, string $msisdn, string $text, string $senderId): SmsResult
    {
        $payload = $this->post($c, '/sendtext', [
            'apikey' => $c->credential('api_key'),
            'secretkey' => $c->credential('secret_key'),
            'callerID' => $senderId,
            'toUser' => $msisdn,
            'messageContent' => $text,
        ]);

        $status = $payload['Status'] ?? $payload['status'] ?? null;
        $messageId = $payload['Message_ID'] ?? $payload['message_id'] ?? $payload['MessageId'] ?? null;
        if ((string) $status === '0') {
            return new SmsResult(is_scalar($messageId) ? (string) $messageId : null, true, $payload);
        }

        $detail = $this->providerText($c, $payload);
        Log::warning('sms.revesms.rejected', ['to' => Phone::mask($msisdn), 'status' => is_scalar($status) ? $status : null, 'text' => $detail]);
        $auth = in_array((string) $status, self::AUTH_STATUSES, true) || preg_match('/credential|password|api ?key|secret|unauthori[sz]ed|authenticat/i', $detail) === 1;

        throw new SmsSendFailed("REVE SMS rejected the message: {$detail}", $auth ? SmsSendFailed::AUTH : SmsSendFailed::REJECTED, $c->providerId, $detail);
    }

    public function balance(SmsConnection $c): ?SmsBalance
    {
        $payload = $this->post($c, '/getbalance', ['apikey' => $c->credential('api_key'), 'secretkey' => $c->credential('secret_key')]);
        $value = $payload['Balance'] ?? $payload['balance'] ?? null;
        if (! is_scalar($value) || preg_match('/^\s*(\d{1,12})(?:\.(\d{1,4}))?\s*$/', (string) $value, $m) !== 1) {
            throw new SmsSendFailed('REVE SMS returned no balance.', SmsSendFailed::UNAVAILABLE, $c->providerId, $this->providerText($c, $payload));
        }

        return new SmsBalance((int) $m[1] * 100 + (int) substr(str_pad($m[2] ?? '', 2, '0'), 0, 2));
    }

    /** @return array<string, mixed> raw status payload */
    public function status(SmsConnection $c, string $messageId): array
    {
        return $this->post($c, '/getstatus', ['apikey' => $c->credential('api_key'), 'secretkey' => $c->credential('secret_key'), 'messageid' => $messageId]);
    }

    /**
     * @param  array<string, string>  $body
     * @return array<string, mixed>
     */
    private function post(SmsConnection $c, string $path, array $body): array
    {
        $url = $c->baseUrl().$path;
        $attempts = max(0, $c->connectRetries) + 1;
        for ($attempt = 1; ; $attempt++) {
            try {
                /** @var Response $response */
                $response = $this->request($c)->post($url, $body);
                break;
            } catch (ConnectionException $e) {
                $detail = $c->redact(Str::limit($e->getMessage(), 200));
                if (self::isReadTimeout($e)) {
                    Log::warning('sms.revesms.timeout', ['path' => $path, 'error' => $detail]);

                    throw new SmsSendFailed('REVE SMS did not answer in time.', SmsSendFailed::TIMEOUT, $c->providerId, 'Timed out after '.$c->timeoutSeconds.' s');
                }
                if ($attempt < $attempts) {
                    usleep(250_000);

                    continue;
                }
                Log::warning('sms.revesms.unreachable', ['path' => $path, 'error' => $detail]);

                throw new SmsSendFailed('REVE SMS is unreachable.', SmsSendFailed::UNAVAILABLE, $c->providerId, 'Could not connect');
            }
        }

        if (in_array($response->status(), [401, 403], true)) {
            throw new SmsSendFailed("REVE SMS refused the credentials (HTTP {$response->status()}).", SmsSendFailed::AUTH, $c->providerId, "HTTP {$response->status()}");
        }
        $json = $response->json();
        if (is_array($json) && array_is_list($json) && isset($json[0]) && is_array($json[0])) {
            $json = $json[0]; // some endpoints wrap the object in a list
        }
        if (! is_array($json) || $response->serverError()) {
            $snippet = $c->redact(Str::limit(trim($response->body()), 200));
            Log::warning('sms.revesms.bad_response', ['path' => $path, 'http' => $response->status(), 'body' => $snippet]);

            throw new SmsSendFailed("REVE SMS returned an unexpected response (HTTP {$response->status()}).", SmsSendFailed::UNAVAILABLE, $c->providerId, "HTTP {$response->status()}");
        }

        return $json;
    }

    private function request(SmsConnection $c): PendingRequest
    {
        $request = Http::connectTimeout(min(10, $c->timeoutSeconds))->timeout($c->timeoutSeconds)->acceptJson()->asJson()->withoutRedirecting();
        if (! $c->trusted) {
            try {
                $pin = ($this->guard ?? app(SmsEndpointGuard::class))->pin($c->baseUrl());
            } catch (InvalidArgumentException $e) {
                throw new SmsSendFailed('The provider endpoint is not allowed.', SmsSendFailed::UNAVAILABLE, $c->providerId, $e->getMessage());
            }
            $request = $request->withOptions(['curl' => [CURLOPT_RESOLVE => $pin]]);
        }

        return $request;
    }

    /** cURL 28 after the connection was made ("Operation timed out … bytes received") = the provider may have the message. */
    public static function isReadTimeout(ConnectionException $e): bool
    {
        $m = $e->getMessage();
        if (str_contains($m, 'Connection timed out') || str_contains($m, 'Failed to connect') || str_contains($m, 'Could not resolve')
            || str_contains($m, 'Connection refused') || str_contains($m, 'resolve host')) {
            return false;
        }

        return str_contains($m, 'timed out') || str_contains($m, 'cURL error 28');
    }

    /** @param  array<string, mixed>  $payload */
    private function providerText(SmsConnection $c, array $payload): string
    {
        $text = $payload['Text'] ?? $payload['text'] ?? $payload['Message'] ?? $payload['message'] ?? 'unknown error';

        return (string) $c->redact(Str::limit(is_scalar($text) ? (string) $text : (string) json_encode($text), 200));
    }
}
