<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Support\Money;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Nagad Online Payment API (PHASE-8-9D §9, P89D-44–P89D-48). Third gateway behind the 5b interface; drivers only REPORT,
 * PaymentService decides (paid only when Verify says `Success` AND the amount equals the charge AND orderId = our
 * payment id AND BDT — rule 8, S342).
 *
 *  initiate  = initialize (`POST check-out/initialize/{merchantId}/{orderId}`: sensitive data RSA-encrypted with the PG
 *              public key, signed SHA256withRSA with the merchant key, headers X-KM-Api-Version / X-KM-IP-V4 /
 *              X-KM-Client-Type; the answer is decrypted with the merchant key and its signature checked with the PG
 *              key) → complete (`POST check-out/complete/{paymentReferenceId}` with amount, currency 050, challenge and
 *              the signed API return URL) → `callBackUrl` (Nagad's hosted page).
 *  complete  = Verify Payment by the payment_ref_id STORED at initiation (the callback's own params are a trigger only).
 *  query     = Verify Payment (`GET verify/payment/{paymentReferenceId}`).
 *  refund    = unsupported until certified → GatewayException `gateway_refund_unsupported` (P89D-48).
 *
 * Every endpoint path, field name and status value is marked VERIFY: they follow Nagad's merchant integration guide and
 * must be checked against the Nagad sandbox before the QA gate. Base URLs come from config by mode (https; an http
 * sandbox only with NAGAD_SANDBOX_ALLOW_HTTP outside production). Logs: ids and statuses only, never keys or bodies.
 */
final class NagadGateway implements PaymentGateway
{
    public const REFUND_UNSUPPORTED = 'gateway_refund_unsupported';

    public function __construct(private readonly SafeHttpClient $http) {}

    public function checkCredentials(PaymentGatewayAccount $account): void
    {
        // P89D-44: an initialize call for a throw-away order id (no money moves).
        $this->initialize($account, 'CHK'.strtoupper(bin2hex(random_bytes(8))), null);
    }

    public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $init = $this->initialize($account, $payment->id, $payment->id);
        $refId = $init['paymentReferenceId'];
        $sensitive = $this->json([
            'merchantId' => $this->merchantId($account),
            'orderId' => $payment->id,
            'currencyCode' => '050', // BDT (ISO 4217 numeric)
            'amount' => Money::toDecimal((int) $payment->amount),
            'challenge' => $init['challenge'],
        ]);
        $body = [
            'sensitiveData' => $this->encrypt($account, $sensitive),
            'signature' => $this->sign($account, $sensitive),
            'merchantCallbackURL' => $returnUrl,
            'additionalMerchantInfo' => ['payment' => $payment->id],
        ];
        $response = $this->call($account, 'post', 'check-out/complete/'.rawurlencode($refId), $body, 'complete', $payment->id);
        $data = $this->decode($response);
        $url = $data['callBackUrl'] ?? null;
        if (strtolower((string) ($data['status'] ?? '')) !== 'success' || ! is_string($url) || ! str_starts_with($url, 'https://')) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Nagad complete failed ('.self::codeOf($data).').');
        }

        return new Initiation($url, $refId, PayloadScrubber::scrub(['status' => $data['status'], 'paymentReferenceId' => $refId]));
    }

    public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
    {
        // The callback's payment_ref_id / status / order_id never decide (S342): Verify by the stored reference.
        return $this->query($payment, $account);
    }

    public function query(Payment $payment, PaymentGatewayAccount $account): Verification
    {
        if ($payment->provider_payment_id === null) {
            return new Verification(Verification::PENDING, null, null, null, null, 'not_initiated');
        }
        $response = $this->call($account, 'get', 'verify/payment/'.rawurlencode($payment->provider_payment_id), null, 'verify', $payment->id);
        $data = $this->decode($response);
        if (! isset($data['status'])) {
            return new Verification(Verification::PENDING, null, null, null, null, 'nagad_'.self::codeOf($data), PayloadScrubber::scrub($data));
        }

        return $this->verification($data);
    }

    public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult
    {
        throw new GatewayException(self::REFUND_UNSUPPORTED, 'Nagad refunds are made in the Nagad merchant portal.');
    }

    public function refundStatus(Payment $refund, PaymentGatewayAccount $account): RefundResult
    {
        return new RefundResult(RefundResult::FAILED, null, self::REFUND_UNSUPPORTED);
    }

    // ---------------------------------------------------------------- protocol (VERIFY against sandbox)

    /** @return array{paymentReferenceId: string, challenge: string} */
    private function initialize(PaymentGatewayAccount $account, string $orderId, ?string $paymentId): array
    {
        $merchantId = $this->merchantId($account);
        $dateTime = now((string) config('payments.providers.nagad.timezone', 'Asia/Dhaka'))->format('YmdHis');
        $sensitive = $this->json(['merchantId' => $merchantId, 'datetime' => $dateTime, 'orderId' => $orderId, 'challenge' => NagadCrypto::challenge()]);
        $body = [
            'accountNumber' => (string) ($account->credentials['merchant_number'] ?? ''),
            'dateTime' => $dateTime,
            'sensitiveData' => $this->encrypt($account, $sensitive),
            'signature' => $this->sign($account, $sensitive),
        ];
        $response = $this->call($account, 'post', 'check-out/initialize/'.rawurlencode($merchantId).'/'.rawurlencode($orderId).'?locale=EN', $body, 'initialize', $paymentId);
        $data = $this->decode($response);
        if ($response->clientError() || ! is_string($data['sensitiveData'] ?? null)) {
            // A rejected merchant id / key / signature: the credentials are wrong.
            throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'Nagad initialize rejected ('.self::codeOf($data).').');
        }
        $plain = NagadCrypto::decrypt($data['sensitiveData'], (string) ($account->credentials['merchant_private_key'] ?? ''));
        if ($plain === null || ! is_string($data['signature'] ?? null) || ! NagadCrypto::verify($plain, $data['signature'], (string) ($account->credentials['pg_public_key'] ?? ''))) {
            throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'Nagad initialize answer could not be decrypted or verified.', 'pg_public_key');
        }
        $decoded = json_decode($plain, true);
        $refId = is_array($decoded) ? ($decoded['paymentReferenceId'] ?? null) : null;
        $challenge = is_array($decoded) ? ($decoded['challenge'] ?? null) : null;
        if (! is_string($refId) || $refId === '' || ! is_string($challenge) || $challenge === '') {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Nagad initialize answer is incomplete.');
        }

        return ['paymentReferenceId' => mb_substr($refId, 0, 128), 'challenge' => $challenge];
    }

    /**
     * VERIFY against sandbox: status values. `Success` is final success; `Aborted` / `Cancelled` = shopper cancelled;
     * `Failed`, `Fraud`, `InvalidRequest`, `Expired` = failed; anything else (Ready, Initiated, Pending) stays pending.
     * Nagad settles in BDT only: a missing currency counts as BDT, a present one must be `050` / `BDT`.
     */
    private function verification(array $data): Verification
    {
        $status = match (strtolower(trim((string) $data['status']))) {
            'success' => Verification::SUCCEEDED,
            'aborted', 'cancelled', 'canceled' => Verification::CANCELLED,
            'failed', 'fraud', 'invalidrequest', 'expired', 'declined' => Verification::FAILED,
            default => Verification::PENDING,
        };
        $currency = $data['currencyCode'] ?? $data['currency'] ?? null;
        $currency = $currency === null || in_array((string) $currency, ['050', '50', 'BDT', 'bdt'], true) ? 'BDT' : (string) $currency;

        return new Verification(
            $status,
            Money::tryFromDecimal($data['amount'] ?? null),
            $currency,
            is_string($data['orderId'] ?? null) ? $data['orderId'] : null,
            self::stringOrNull($data['issuerPaymentRefNo'] ?? $data['paymentRefId'] ?? null),
            in_array($status, [Verification::FAILED, Verification::CANCELLED], true) ? 'nagad_'.strtolower(preg_replace('/[^A-Za-z0-9]/', '', (string) $data['status']) ?: 'failed') : null,
            PayloadScrubber::scrub(array_intersect_key($data, array_flip(['status', 'statusCode', 'orderId', 'paymentRefId', 'amount', 'issuerPaymentRefNo', 'issuerPaymentDateTime']))),
        );
    }

    // ---------------------------------------------------------------- HTTP + crypto

    private function client(PaymentGatewayAccount $account): PendingRequest
    {
        $base = $account->baseUrl() ?? throw new GatewayException(GatewayException::NOT_CONNECTED, 'Nagad live base URL is not configured (NAGAD_LIVE_BASE_URL).');
        $request = str_starts_with($base, 'http://') && $account->mode === PaymentGatewayAccount::SANDBOX
            && (bool) config('payments.providers.nagad.sandbox_allow_http') && ! app()->environment('production')
            ? Http::baseUrl($base)->connectTimeout((int) config('payments.http.connect_timeout', 10))->timeout((int) config('payments.http.timeout', 30))->withoutRedirecting()->acceptJson()
            : $this->http->to($base);

        return $request->asJson()->withHeaders([
            'X-KM-Api-Version' => (string) config('payments.providers.nagad.api_version', 'v-0.2.0'),
            'X-KM-IP-V4' => self::ip(),
            'X-KM-Client-Type' => (string) config('payments.providers.nagad.client_type', 'PC_WEB'),
        ]);
    }

    /** @param array<string, mixed>|null $body */
    private function call(PaymentGatewayAccount $account, string $method, string $path, ?array $body, string $action, ?string $paymentId): Response
    {
        try {
            $response = $method === 'get' ? $this->client($account)->get($path) : $this->client($account)->post($path, $body ?? []);
        } catch (ConnectionException) {
            SafeHttpClient::log('nagad', $action, null, ['payment_id' => $paymentId, 'account_id' => $account->id]);
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "Nagad {$action} timed out.");
        }
        SafeHttpClient::log('nagad', $action, $response->status(), ['payment_id' => $paymentId, 'account_id' => $account->id]);
        if ($response->serverError()) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "Nagad {$action} returned HTTP {$response->status()}.");
        }

        return $response;
    }

    /** @return array<string, mixed> */
    private function decode(Response $response): array
    {
        $data = $response->json();

        return is_array($data) ? $data : [];
    }

    private function encrypt(PaymentGatewayAccount $account, string $json): string
    {
        return NagadCrypto::encrypt($json, (string) ($account->credentials['pg_public_key'] ?? ''))
            ?? throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'Nagad public key can’t encrypt.', 'pg_public_key');
    }

    private function sign(PaymentGatewayAccount $account, string $json): string
    {
        return NagadCrypto::sign($json, (string) ($account->credentials['merchant_private_key'] ?? ''))
            ?? throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'Nagad merchant key can’t sign.', 'merchant_private_key');
    }

    private function merchantId(PaymentGatewayAccount $account): string
    {
        return (string) ($account->credentials['merchant_id'] ?? '');
    }

    /** @param array<string, mixed> $data */
    private function json(array $data): string
    {
        return (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private static function ip(): string
    {
        $ip = app()->runningInConsole() ? null : request()->ip();

        return is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false ? $ip : (string) config('payments.providers.nagad.server_ip', '127.0.0.1');
    }

    private static function codeOf(array $data): string
    {
        $code = $data['reason'] ?? $data['statusCode'] ?? $data['status'] ?? 'unknown';

        return preg_replace('/[^A-Za-z0-9_]/', '', (string) $code) ?: 'unknown';
    }

    private static function stringOrNull(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : (is_int($value) ? (string) $value : null);
    }
}
