<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;

/**
 * bKash Tokenized Checkout v2 (PHASE-5B §5.1, public docs checked 2026-11-22).
 *
 * Grant token: fetched lazily and cached per account in TenantCache for `expires_in − 600 s`, then refreshed with the
 * refresh token (30 days). bKash limits grant + refresh to 2 calls/hour per app (over → 1-hour block), so the driver
 * never grants per request: it counts its own calls (rolling hour) and refuses a third, and a failed grant is cached
 * as an error for 5 minutes.
 *
 * Every undocumented detail is marked `VERIFY against sandbox` and isolated in one method.
 */
final class BkashGateway implements PaymentGateway
{
    public function __construct(
        private readonly SafeHttpClient $http,
        private readonly TenantCache $cache,
    ) {}

    public function checkCredentials(PaymentGatewayAccount $account): void
    {
        $this->token($account, fresh: true);
    }

    public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $response = $this->call($account, 'payment/create', $this->createBody($payment, $returnUrl), 'create', $payment);
        $body = $this->json($response);
        $paymentId = self::paymentIdOf($body);
        $url = $body['bkashURL'] ?? null;
        if ($paymentId === null || ! is_string($url) || ! str_starts_with($url, 'https://')) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'bKash create payment failed ('.self::codeOf($body).').');
        }

        return new Initiation($url, $paymentId, PayloadScrubber::scrub($body));
    }

    /**
     * Callback `status=success` → Execute; on a timeout or an unclear answer → Query, and Execute again only while the
     * payment is still `Initiated`. `failure` / `cancel` → Query once: a Completed payment still wins (provider truth),
     * else failed / cancelled. The callback's paymentID is ignored: we use the id stored at initiation (S22).
     */
    public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
    {
        if ($payment->provider_payment_id === null) {
            return new Verification(Verification::FAILED, null, null, null, null, 'unknown_payment');
        }

        $callback = is_string($params['status'] ?? null) ? $params['status'] : 'success';
        if ($callback !== 'success') {
            $state = $this->query($payment, $account);
            if ($state->status !== Verification::PENDING) {
                return $state;
            }
            $cancelled = $callback === 'cancel';

            return new Verification(
                $cancelled ? Verification::CANCELLED : Verification::FAILED,
                $state->amount, $state->currency, $state->reference, $state->providerTrxId,
                $cancelled ? 'cancelled_by_shopper' : 'payment_failed', $state->raw,
            );
        }

        for ($attempt = 1; $attempt <= 2; $attempt++) {
            try {
                $body = $this->json($this->call($account, 'payment/execute', [$this->paymentIdKey() => $payment->provider_payment_id], 'execute', $payment));
                if (isset($body['transactionStatus'])) {
                    return $this->verification($body);
                }
            } catch (GatewayException $e) {
                if ($e->errorCode !== GatewayException::PROVIDER_UNAVAILABLE) {
                    throw $e;
                }
            }

            // Timeout, 5xx or an execute error ("already executed", "invalid state"): the provider state decides.
            $state = $this->query($payment, $account);
            if ($state->status !== Verification::PENDING || $attempt === 2) {
                return $state;
            }
        }

        return $this->query($payment, $account); // unreachable; keeps static analysis happy
    }

    public function query(Payment $payment, PaymentGatewayAccount $account): Verification
    {
        if ($payment->provider_payment_id === null) {
            return new Verification(Verification::PENDING, null, null, null, null, 'not_initiated');
        }
        $body = $this->json($this->call($account, 'query/payment', [$this->paymentIdKey() => $payment->provider_payment_id], 'query', $payment));
        if (! isset($body['transactionStatus'])) {
            return new Verification(Verification::PENDING, null, null, null, null, 'bkash_'.self::codeOf($body), PayloadScrubber::scrub($body));
        }

        return $this->verification($body);
    }

    public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult
    {
        $body = [
            $this->paymentIdKey() => $charge->provider_payment_id,
            'trxId' => $charge->provider_trx_id,
            'refundAmount' => Money::toDecimal($amount),
            'sku' => $refund->id, // provider idempotency reference = our refund payment id (P5B-24)
            'reason' => mb_substr($reason !== null && trim($reason) !== '' ? $reason : 'Refund', 0, 255),
        ];

        try {
            $response = $this->json($this->call($account, 'refund/payment/transaction', $body, 'refund', $refund));
        } catch (GatewayException $e) {
            if ($e->errorCode !== GatewayException::PROVIDER_UNAVAILABLE) {
                throw $e;
            }
            // Timeout / 5xx: the refund may have happened. Ask once; if that fails too, it stays processing.
            try {
                return $this->refundStatus($refund, $account, $charge);
            } catch (GatewayException) {
                return new RefundResult(RefundResult::PROCESSING, null, 'timeout');
            }
        }

        return $this->refundResult($response);
    }

    public function refundStatus(Payment $refund, PaymentGatewayAccount $account, ?Payment $charge = null): RefundResult
    {
        $charge ??= $refund->parent_payment_id !== null ? Payment::query()->find($refund->parent_payment_id) : null;
        if ($charge === null) {
            return new RefundResult(RefundResult::FAILED, null, 'unknown_charge');
        }
        $body = $this->json($this->call($account, 'refund/payment/status', [
            $this->paymentIdKey() => $charge->provider_payment_id,
            'trxId' => $charge->provider_trx_id,
        ], 'refund_status', $refund));

        $match = $this->matchRefund($body, $refund);
        if ($match === null) {
            return new RefundResult(RefundResult::FAILED, null, 'refund_not_found', PayloadScrubber::scrub($body));
        }

        return $this->refundResult($match + ['_listing' => PayloadScrubber::scrub($body)]);
    }

    // ---------------------------------------------------------------- token management

    /** A valid id_token for the account (cached → refresh → grant), guarded by the 2-calls/hour limit. */
    private function token(PaymentGatewayAccount $account, bool $fresh = false): string
    {
        $key = $this->cacheKey($account);
        $entry = $this->cache->get($key.':token');
        if (! $fresh && is_array($entry) && ($entry['use_until'] ?? 0) > now()->getTimestamp()) {
            return (string) $entry['id_token'];
        }

        $failure = $this->cache->get($key.':grant_failure');
        if (is_string($failure)) {
            throw new GatewayException($failure, 'bKash token request failed recently; retrying after the 5-minute back-off.');
        }

        try {
            if (! $fresh && is_array($entry) && is_string($entry['refresh_token'] ?? null)) {
                try {
                    return $this->storeToken($account, $this->tokenCall($account, 'auth/refresh-token', ['refresh_token' => $entry['refresh_token']], 'refresh'));
                } catch (GatewayException $e) {
                    if ($e->errorCode !== GatewayException::CREDENTIALS_INVALID) {
                        throw $e;
                    }
                    // Refresh token rejected (expired / revoked): fall back to a grant.
                }
            }

            return $this->storeToken($account, $this->tokenCall($account, 'auth/grant-token', [], 'grant'));
        } catch (GatewayException $e) {
            if ($e->field !== 'rate_guard') {
                $this->cache->put($key.':grant_failure', $e->errorCode, (int) config('payments.providers.bkash.grant_failure_seconds', 300));
            }
            throw $e;
        }
    }

    /** @return array<string, mixed> the token response */
    private function tokenCall(PaymentGatewayAccount $account, string $path, array $extra, string $action): array
    {
        $this->guardTokenCalls($account);
        $credentials = $account->credentials;
        try {
            $response = $this->client($account)
                ->withHeaders(['username' => (string) ($credentials['username'] ?? ''), 'password' => (string) ($credentials['password'] ?? '')])
                ->post($path, ['app_key' => (string) ($credentials['app_key'] ?? ''), 'app_secret' => (string) ($credentials['app_secret'] ?? '')] + $extra);
        } catch (ConnectionException) {
            SafeHttpClient::log('bkash', $action, null, ['account_id' => $account->id]);
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "bKash {$action} timed out.");
        }
        SafeHttpClient::log('bkash', $action, $response->status(), ['account_id' => $account->id]);
        if ($response->serverError()) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "bKash {$action} returned HTTP {$response->status()}.");
        }
        $body = $this->json($response);
        if (! is_string($body['id_token'] ?? null) || $body['id_token'] === '') {
            throw new GatewayException(GatewayException::CREDENTIALS_INVALID, "bKash {$action} rejected (".self::codeOf($body).').');
        }

        return $body;
    }

    private function storeToken(PaymentGatewayAccount $account, array $body): string
    {
        $expiresIn = is_numeric($body['expires_in'] ?? null) ? (int) $body['expires_in'] : 3600;
        $margin = (int) config('payments.providers.bkash.token_margin_seconds', 600);
        $this->cache->put($this->cacheKey($account).':token', [
            'id_token' => (string) $body['id_token'],
            'refresh_token' => is_string($body['refresh_token'] ?? null) ? $body['refresh_token'] : null,
            'use_until' => now()->getTimestamp() + max(60, $expiresIn - $margin),
        ], 29 * 86400); // the refresh token lives 30 days
        $this->cache->forget($this->cacheKey($account).':grant_failure');

        return (string) $body['id_token'];
    }

    /** grant + refresh ≤ 2 per rolling hour per account (bKash blocks the app for an hour beyond that). */
    private function guardTokenCalls(PaymentGatewayAccount $account): void
    {
        $key = $this->cacheKey($account).':token_calls';
        $now = now()->getTimestamp();
        $calls = array_values(array_filter((array) $this->cache->get($key, []), fn ($t) => is_int($t) && $t > $now - 3600));
        if (count($calls) >= (int) config('payments.providers.bkash.grant_calls_per_hour', 2)) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'bKash token call limit (2 per hour) reached.', 'rate_guard');
        }
        $calls[] = $now;
        $this->cache->put($key, $calls, 3600);
    }

    /** Cache identity: account + mode + a keyed fingerprint of the credentials (new credentials → new token). */
    private function cacheKey(PaymentGatewayAccount $account): string
    {
        $fingerprint = substr(hash_hmac('sha256', $account->mode.'|'.json_encode($account->credentials), (string) config('app.key')), 0, 16);

        return "payments:bkash:{$account->id}:{$fingerprint}";
    }

    // ---------------------------------------------------------------- HTTP

    private function client(PaymentGatewayAccount $account): PendingRequest
    {
        $base = $account->baseUrl() ?? throw new GatewayException(GatewayException::NOT_CONNECTED, 'bKash live base URL is not configured (BKASH_LIVE_BASE_URL).');

        return $this->http->to($base)->asJson();
    }

    /** An authorised API call; a 401 drops the cached token and retries once. */
    private function call(PaymentGatewayAccount $account, string $path, array $body, string $action, Payment $payment): Response
    {
        for ($try = 1; ; $try++) {
            $token = $this->token($account);
            try {
                $response = $this->client($account)
                    ->withHeaders(['Authorization' => $this->authorizationHeader($token), 'X-App-Key' => (string) ($account->credentials['app_key'] ?? '')])
                    ->post($path, $body);
            } catch (ConnectionException) {
                SafeHttpClient::log('bkash', $action, null, ['payment_id' => $payment->id, 'account_id' => $account->id]);
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "bKash {$action} timed out.");
            }
            SafeHttpClient::log('bkash', $action, $response->status(), ['payment_id' => $payment->id, 'account_id' => $account->id]);

            if ($response->status() === 401 && $try === 1) {
                $this->cache->forget($this->cacheKey($account).':token');

                continue;
            }
            if ($response->serverError() || $response->status() === 401) {
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "bKash {$action} returned HTTP {$response->status()}.");
            }

            return $response;
        }
    }

    /** @return array<string, mixed> */
    private function json(Response $response): array
    {
        $data = $response->json();

        return is_array($data) ? $data : [];
    }

    // ---------------------------------------------------------------- VERIFY against sandbox (one method each)

    /**
     * VERIFY against sandbox: the v2 docs' tables say "Bearer {id_token}" but every sample sends the raw token.
     */
    private function authorizationHeader(string $token): string
    {
        return $token;
    }

    /** VERIFY against sandbox: v2 docs write `paymentId`; the older v1.2 API used `paymentID` (responses: both read). */
    private function paymentIdKey(): string
    {
        return 'paymentId';
    }

    /**
     * VERIFY against sandbox: `mode: "0011"` (checkout URL flow) is required by the older tokenized API and not listed
     * in the v2 create table; `payerReference` for test payments (no shopper) is a placeholder.
     *
     * @return array<string, string>
     */
    private function createBody(Payment $payment, string $returnUrl): array
    {
        $phone = $payment->order_id !== null ? (string) $payment->order?->customer_phone : '';

        return [
            'mode' => '0011',
            'payerReference' => $phone !== '' ? $phone : '01000000000',
            'callbackURL' => $returnUrl,
            'amount' => Money::toDecimal($payment->amount),
            'currency' => 'BDT',
            'intent' => 'sale',
            'merchantInvoiceNumber' => $payment->id,
        ];
    }

    /**
     * VERIFY against sandbox: the docs list `Completed` and `Initiated` only. `Cancelled`, `Failed`, `Expired` and
     * `Pending Authorized` are inferred; anything unknown stays pending (reconcile asks again).
     */
    private function mapStatus(string $status): string
    {
        return match (strtolower(trim($status))) {
            'completed' => Verification::SUCCEEDED,
            'cancelled', 'canceled' => Verification::CANCELLED,
            'failed', 'failure', 'expired', 'declined' => Verification::FAILED,
            default => Verification::PENDING, // Initiated, Pending Authorized, Authorized, unknown
        };
    }

    /**
     * VERIFY against sandbox: whether the refund status listing echoes our `sku`; until then a refund is matched by
     * refundTrxId (when stored on the refund payment) or by amount.
     *
     * @return array<string, mixed>|null
     */
    private function matchRefund(array $body, Payment $refund): ?array
    {
        $rows = is_array($body['refundTransactions'] ?? null) ? $body['refundTransactions'] : (isset($body['refundTrxId']) || isset($body['refundTrxID']) ? [$body] : []);
        $known = $refund->provider_payment_id ?? $refund->provider_trx_id;
        $amount = Money::toDecimal($refund->amount);
        foreach ($rows as $row) {
            if (! is_array($row)) {
                continue;
            }
            $trx = $row['refundTrxId'] ?? $row['refundTrxID'] ?? null;
            if (($row['sku'] ?? null) === $refund->id || ($known !== null && $trx === $known)) {
                return $row;
            }
        }
        foreach ($rows as $row) {
            if (is_array($row) && Money::tryFromDecimal($row['refundAmount'] ?? $row['amount'] ?? null) === Money::fromDecimal($amount)) {
                return $row;
            }
        }

        return null;
    }

    // ---------------------------------------------------------------- mapping

    private function verification(array $body): Verification
    {
        $status = $this->mapStatus((string) $body['transactionStatus']);

        return new Verification(
            $status,
            Money::tryFromDecimal($body['amount'] ?? null),
            is_string($body['currency'] ?? null) ? $body['currency'] : null,
            is_string($body['merchantInvoiceNumber'] ?? null) ? $body['merchantInvoiceNumber'] : null,
            self::stringOrNull($body['trxID'] ?? $body['trxId'] ?? null),
            in_array($status, [Verification::FAILED, Verification::CANCELLED], true) ? 'bkash_'.strtolower(str_replace(' ', '_', (string) $body['transactionStatus'])) : null,
            PayloadScrubber::scrub($body),
        );
    }

    private function refundResult(array $body): RefundResult
    {
        $status = $body['refundTransactionStatus'] ?? $body['transactionStatus'] ?? null;
        $refundId = self::stringOrNull($body['refundTrxId'] ?? $body['refundTrxID'] ?? null);
        $raw = PayloadScrubber::scrub($body);
        if (is_string($status) && strtolower($status) === 'completed') {
            return new RefundResult(RefundResult::SUCCEEDED, $refundId, null, $raw);
        }
        if (is_string($status) && in_array(strtolower($status), ['initiated', 'pending', 'processing'], true)) {
            return new RefundResult(RefundResult::PROCESSING, $refundId, null, $raw);
        }

        return new RefundResult(RefundResult::FAILED, $refundId, 'bkash_'.self::codeOf($body), $raw);
    }

    private static function paymentIdOf(array $body): ?string
    {
        return self::stringOrNull($body['paymentID'] ?? $body['paymentId'] ?? null);
    }

    /** Provider error code for logs/failure codes: statusCode (v2) or errorCode (v1.2). */
    private static function codeOf(array $body): string
    {
        $code = $body['statusCode'] ?? $body['errorCode'] ?? 'unknown';

        return preg_replace('/[^A-Za-z0-9_]/', '', (string) $code) ?: 'unknown';
    }

    private static function stringOrNull(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : (is_int($value) ? (string) $value : null);
    }
}
