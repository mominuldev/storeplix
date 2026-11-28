<?php

declare(strict_types=1);

namespace App\Domain\Sms\Drivers;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Sms\Providers\SmsBalance;
use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\Providers\SmsEndpointGuard;
use App\Domain\Sms\Providers\SmsProviderDriver;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use InvalidArgumentException;

/**
 * PHASE-8-9B P89B-3: generic HTTP provider. `settings.http` (SmsHttpMapping) says how to call it: method, body format
 * (json | form | query), the parameter names for to / text / sender and for each credential, the JSON path + value that
 * means "accepted" and the message-id path. Calls go through SafeHttpClient (https only, no redirects) with the DNS pin
 * of SmsEndpointGuard (S224). 5xx / 429 / connect errors → `unavailable`; 401/403 → `auth`; read timeout → `timeout`;
 * an answer without the success value → `rejected`. No balance in 8.9b (`unsupported`).
 */
final class HttpDriver implements SmsProviderDriver
{
    public function __construct(private readonly SmsEndpointGuard $guard) {}

    public function send(SmsConnection $c, string $msisdn, string $text, string $senderId): SmsResult
    {
        $map = (array) ($c->setting('http') ?? []);
        $url = $c->baseUrl();
        try {
            $pin = $this->guard->pin($url);
        } catch (InvalidArgumentException $e) {
            throw new SmsSendFailed('The provider endpoint is not allowed.', SmsSendFailed::UNAVAILABLE, $c->providerId, $e->getMessage());
        }
        $params = [
            (string) ($map['to_param'] ?? 'to') => $msisdn,
            (string) ($map['text_param'] ?? 'text') => $text,
        ];
        if (($map['sender_param'] ?? '') !== '') {
            $params[(string) $map['sender_param']] = $senderId;
        }
        foreach ((array) ($map['credential_params'] ?? []) as $key => $param) {
            $params[(string) $param] = $c->credential((string) $key);
        }

        $method = strtoupper((string) ($map['method'] ?? 'POST')) === 'GET' ? 'GET' : 'POST';
        $format = (string) ($map['body_format'] ?? 'json');
        // SafeHttpClient's rules (checked by the guard) on the full endpoint URL; no redirects; pinned address.
        $request = Http::withoutRedirecting()->acceptJson()
            ->connectTimeout(min(10, $c->timeoutSeconds))->timeout($c->timeoutSeconds)
            ->withOptions(['curl' => [CURLOPT_RESOLVE => $pin]]);
        $started = microtime(true);
        try {
            /** @var Response $response */
            $response = match (true) {
                $method === 'GET' => $request->get($url, $params),
                $format === 'query' => $request->withQueryParameters($params)->post($url),
                $format === 'form' => $request->asForm()->post($url, $params),
                default => $request->asJson()->post($url, $params),
            };
        } catch (ConnectionException $e) {
            $timeout = RevesmsDriver::isReadTimeout($e);
            SafeHttpClient::log('sms_http', 'send', null, ['provider_id' => $c->providerId]);

            throw new SmsSendFailed($timeout ? 'The SMS provider did not answer in time.' : 'The SMS provider is unreachable.',
                $timeout ? SmsSendFailed::TIMEOUT : SmsSendFailed::UNAVAILABLE, $c->providerId, $timeout ? 'Timed out after '.$c->timeoutSeconds.' s' : 'Could not connect');
        }
        SafeHttpClient::log('sms_http', 'send', $response->status(), ['provider_id' => $c->providerId, 'ms' => (int) ((microtime(true) - $started) * 1000)]);

        if (in_array($response->status(), [401, 403], true)) {
            throw new SmsSendFailed("The SMS provider refused the credentials (HTTP {$response->status()}).", SmsSendFailed::AUTH, $c->providerId, "HTTP {$response->status()}");
        }
        if ($response->serverError() || $response->status() === 429 || $response->redirect()) {
            throw new SmsSendFailed("The SMS provider is unavailable (HTTP {$response->status()}).", SmsSendFailed::UNAVAILABLE, $c->providerId, "HTTP {$response->status()}");
        }
        $json = $response->json();
        if (! is_array($json)) {
            throw new SmsSendFailed("The SMS provider returned an unexpected response (HTTP {$response->status()}).", SmsSendFailed::UNAVAILABLE, $c->providerId,
                $c->redact(Str::limit(trim($response->body()), 200)));
        }
        $value = Arr::get($json, (string) ($map['success_path'] ?? 'status'));
        if (is_scalar($value) && (string) $value === (string) ($map['success_value'] ?? '')) {
            $idPath = $map['message_id_path'] ?? null;
            $id = is_string($idPath) && $idPath !== '' ? Arr::get($json, $idPath) : null;

            return new SmsResult(is_scalar($id) ? (string) $id : null, true, ['http' => $response->status()]);
        }

        $detail = $c->redact(Str::limit((string) json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 200));

        throw new SmsSendFailed('The SMS provider rejected the message.', SmsSendFailed::REJECTED, $c->providerId, $detail);
    }

    public function balance(SmsConnection $c): ?SmsBalance
    {
        return null; // Q286: HTTP-driver balance later
    }
}
