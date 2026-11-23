<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Support\Money;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Str;

/**
 * SSLCommerz v4 (PHASE-5B §5.2; developer.sslcommerz.com/doc/v4, verify_sign from the official PHP SDK).
 *
 * Session init → GatewayPageURL; the browser return and the IPN are triggers only: the Order Validation API (val_id)
 * or the transaction query (tran_id) decides. `risk_level` stays in Verification::raw for PaymentService (risk tag).
 * Undocumented details are marked `VERIFY against sandbox` and isolated in one method each.
 */
class SslCommerzGateway implements PaymentGateway
{
    private const SESSION = 'gwprocess/v4/api.php';

    private const VALIDATION = 'validator/api/validationserverAPI.php';

    private const TRANSACTION = 'validator/api/merchantTransIDvalidationAPI.php';

    public function __construct(private readonly SafeHttpClient $http) {}

    /** ৳ 10 session marked as a check, discarded (never paid): FAILED = credentials rejected. */
    public function checkCredentials(PaymentGatewayAccount $account): void
    {
        $base = rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/').'/api/v1/health';
        $fields = $this->credentialFields($account) + [
            'total_amount' => Money::toDecimal(1000),
            'currency' => 'BDT',
            'tran_id' => 'SPCHECK'.Str::upper(Str::random(19)),
            'success_url' => $base, 'fail_url' => $base, 'cancel_url' => $base,
            'cus_name' => 'Storeplix check', 'cus_email' => $this->fallbackEmail('check'), 'cus_add1' => 'Dhaka',
            'cus_city' => 'Dhaka', 'cus_postcode' => '1000', 'cus_country' => 'Bangladesh', 'cus_phone' => '01000000000',
            'shipping_method' => 'NO', 'num_of_item' => 1, 'product_name' => 'Credential check',
            'product_category' => 'general', 'product_profile' => 'general', 'value_a' => 'credential-check',
        ];
        $body = $this->json($this->send($account, 'post', self::SESSION, $fields, 'check', null));
        if (strtoupper((string) ($body['status'] ?? '')) !== 'SUCCESS') {
            throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'SSLCommerz rejected the store credentials.');
        }
    }

    public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $fields = $this->credentialFields($account) + $this->sessionFields($payment, $returnUrl, $ipnUrl);
        $body = $this->json($this->send($account, 'post', self::SESSION, $fields, 'session', $payment));
        $url = $body['GatewayPageURL'] ?? null;
        if (strtoupper((string) ($body['status'] ?? '')) !== 'SUCCESS' || ! is_string($url) || ! str_starts_with($url, 'https://')) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'SSLCommerz session init failed.');
        }

        // The session key is a hosted-page credential: not stored (raw is scrubbed, provider_payment_id stays null).
        return new Initiation($url, null, PayloadScrubber::scrub($body));
    }

    /** Browser return: `val_id` → Validation API; without one (fail / cancel) → query by tran_id. */
    public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
    {
        $valId = $params['val_id'] ?? null;
        if (is_string($valId) && $valId !== '' && strlen($valId) <= 128) {
            return $this->validate($payment, $account, $valId);
        }

        $state = $this->query($payment, $account);
        if ($state->status !== Verification::PENDING) {
            return $state;
        }
        $hint = strtoupper(is_string($params['status'] ?? null) ? $params['status'] : '');
        $cancelled = $hint === 'CANCELLED' || ($params['r'] ?? null) === 'cancel';
        if ($cancelled || in_array($hint, ['FAILED', 'EXPIRED'], true) || ($params['r'] ?? null) === 'fail') {
            return new Verification($cancelled ? Verification::CANCELLED : Verification::FAILED, $state->amount, $state->currency,
                $state->reference, $state->providerTrxId, $cancelled ? 'cancelled_by_shopper' : 'payment_failed', $state->raw);
        }

        return $state;
    }

    /** Order Validation API: VALID / VALIDATED = final success (validated twice is still success). */
    public function validate(Payment $payment, PaymentGatewayAccount $account, string $valId): Verification
    {
        $body = $this->json($this->send($account, 'get', self::VALIDATION, $this->credentialFields($account) + ['val_id' => $valId, 'format' => 'json'], 'validate', $payment));

        return $this->verification($body, (string) ($body['status'] ?? ''));
    }

    public function query(Payment $payment, PaymentGatewayAccount $account): Verification
    {
        $body = $this->json($this->send($account, 'get', self::TRANSACTION, $this->credentialFields($account) + ['tran_id' => $payment->id, 'format' => 'json'], 'query', $payment));
        $elements = array_values(array_filter(is_array($body['element'] ?? null) ? $body['element'] : [], 'is_array'));
        if ($elements === []) {
            return new Verification(Verification::PENDING, null, null, null, null, null, PayloadScrubber::scrub($body));
        }
        // A successful attempt wins; otherwise the most informative state (pending > cancelled > failed).
        $rank = fn (array $e) => match ($this->mapStatus((string) ($e['status'] ?? ''))) {
            Verification::SUCCEEDED => 0, Verification::PENDING => 1, Verification::CANCELLED => 2, default => 3,
        };
        usort($elements, fn ($a, $b) => $rank($a) <=> $rank($b));

        return $this->verification($elements[0] + ['_elements' => count($elements)], (string) ($elements[0]['status'] ?? ''));
    }

    /** VERIFY against sandbox: partial refunds (Q48 default: allowed; a refusal is reported as failed). */
    public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult
    {
        if ($charge->provider_trx_id === null) {
            return new RefundResult(RefundResult::FAILED, null, 'missing_bank_tran_id');
        }
        try {
            $body = $this->json($this->send($account, 'get', self::TRANSACTION, $this->credentialFields($account) + [
                'bank_tran_id' => $charge->provider_trx_id,
                'refund_trans_id' => $refund->id,
                'refund_amount' => Money::toDecimal($amount),
                'refund_remarks' => mb_substr($reason !== null && trim($reason) !== '' ? $reason : 'Refund', 0, 255),
                'refe_id' => $refund->id,
                'format' => 'json',
            ], 'refund', $refund));
        } catch (GatewayException $e) {
            if ($e->errorCode !== GatewayException::PROVIDER_UNAVAILABLE) {
                throw $e;
            }

            return new RefundResult(RefundResult::PROCESSING, null, 'timeout');
        }

        $refId = self::stringOrNull($body['refund_ref_id'] ?? null);
        $raw = PayloadScrubber::scrub($body);
        if (strtoupper((string) ($body['APIConnect'] ?? '')) !== 'DONE') {
            return new RefundResult(RefundResult::FAILED, $refId, 'sslcommerz_'.self::code($body['APIConnect'] ?? 'unknown'), $raw);
        }

        return match (strtolower((string) ($body['status'] ?? ''))) {
            'success' => new RefundResult(RefundResult::SUCCEEDED, $refId, null, $raw),
            'processing' => new RefundResult(RefundResult::PROCESSING, $refId, null, $raw),
            default => new RefundResult(RefundResult::FAILED, $refId, 'sslcommerz_refund_'.self::code($body['status'] ?? 'failed'), $raw),
        };
    }

    /** Refund status by refund_ref_id (stored from RefundResult::providerRefundId on the refund's provider_payment_id). */
    public function refundStatus(Payment $refund, PaymentGatewayAccount $account): RefundResult
    {
        $refId = $refund->provider_payment_id ?? $refund->provider_trx_id;
        if ($refId === null) {
            // The refund call timed out before SSLCommerz returned a reference: never re-send blindly.
            return new RefundResult(RefundResult::PROCESSING, null, 'refund_reference_missing');
        }
        $body = $this->json($this->send($account, 'get', self::TRANSACTION, $this->credentialFields($account) + ['refund_ref_id' => $refId, 'format' => 'json'], 'refund_status', $refund));
        $raw = PayloadScrubber::scrub($body);

        return match (strtolower((string) ($body['status'] ?? ''))) {
            'refunded' => new RefundResult(RefundResult::SUCCEEDED, $refId, null, $raw),
            'processing' => new RefundResult(RefundResult::PROCESSING, $refId, null, $raw),
            'cancelled' => new RefundResult(RefundResult::FAILED, $refId, 'sslcommerz_refund_cancelled', $raw),
            default => new RefundResult(RefundResult::PROCESSING, $refId, 'sslcommerz_'.self::code($body['APIConnect'] ?? $body['status'] ?? 'unknown'), $raw),
        };
    }

    /**
     * IPN / browser POST pre-filter (official PHP SDK scheme): md5 over the `verify_key` fields plus
     * store_passwd = md5(store_passwd), sorted by key, joined "k=v&". A cheap filter only: the Validation API decides.
     *
     * @param  array<string, mixed>  $params
     */
    public static function verifySign(array $params, string $storePasswd): bool
    {
        $sign = $params['verify_sign'] ?? null;
        $keys = $params['verify_key'] ?? null;
        if (! is_string($sign) || ! is_string($keys) || $sign === '' || $keys === '') {
            return false;
        }
        $data = [];
        foreach (explode(',', $keys) as $key) {
            if ($key === '' || ! array_key_exists($key, $params) || ! is_scalar($params[$key])) {
                return false;
            }
            $data[$key] = (string) $params[$key];
        }
        $data['store_passwd'] = md5($storePasswd);
        ksort($data);
        $pairs = [];
        foreach ($data as $key => $value) {
            $pairs[] = $key.'='.$value;
        }

        return hash_equals(md5(implode('&', $pairs)), strtolower($sign));
    }

    // ---------------------------------------------------------------- request building

    /** @return array{store_id: string, store_passwd: string} */
    private function credentialFields(PaymentGatewayAccount $account): array
    {
        return ['store_id' => (string) ($account->credentials['store_id'] ?? ''), 'store_passwd' => (string) ($account->credentials['store_passwd'] ?? '')];
    }

    /**
     * Session fields: only those listed in §5.2 (no PII beyond them). One signed return URL serves success, fail and
     * cancel (the POSTed `status` and the Validation API decide). VERIFY against sandbox: whether `cus_postcode` is
     * required (placeholder 1000) and whether `shipping_method` must be "Courier" for test charges.
     *
     * @return array<string, scalar>
     */
    protected function sessionFields(Payment $payment, string $returnUrl, ?string $ipnUrl): array
    {
        /** @var Order|null $order */
        $order = $payment->order_id !== null ? $payment->order()->with('items')->first() : null;
        $address = $order?->shipping_address ?? [];
        $items = $order?->items ?? collect();
        $first = $items->sortBy('position')->first();

        $fields = [
            'total_amount' => Money::toDecimal($payment->amount),
            'currency' => 'BDT',
            'tran_id' => $payment->id,
            'success_url' => $returnUrl,
            'fail_url' => $returnUrl,
            'cancel_url' => $returnUrl,
            'cus_name' => mb_substr($order?->customer_name ?: 'Test payment', 0, 50),
            'cus_email' => $order?->customer_email ?: $this->fallbackEmail($order?->number ?? 'test-'.strtolower(substr($payment->id, -8))),
            'cus_add1' => mb_substr((string) ($address['address_line'] ?? 'Dhaka'), 0, 50),
            'cus_city' => mb_substr((string) ($address['district'] ?? 'Dhaka'), 0, 50),
            'cus_postcode' => '1000',
            'cus_country' => 'Bangladesh',
            'cus_phone' => $order?->customer_phone ?: '01000000000',
            'shipping_method' => 'Courier',
            'num_of_item' => max(1, (int) $items->sum('quantity')),
            'product_name' => mb_substr($first?->product_name ?? 'Test payment', 0, 255),
            'product_category' => 'general',
            'product_profile' => 'physical-goods',
            'value_a' => $order?->number ?? 'test',
        ];
        if ($ipnUrl !== null) {
            $fields['ipn_url'] = $ipnUrl;
        }
        if ($fields['shipping_method'] === 'Courier') {
            // SSLCommerz requires the ship_* block when shipping_method is not "NO".
            $fields += ['ship_name' => $fields['cus_name'], 'ship_add1' => $fields['cus_add1'], 'ship_city' => $fields['cus_city'],
                'ship_postcode' => '1000', 'ship_country' => 'Bangladesh'];
        }

        return $fields;
    }

    protected function fallbackEmail(string $tag): string
    {
        $tag = preg_replace('/[^A-Za-z0-9-]/', '', $tag) ?: 'order';

        return 'noreply+'.strtolower($tag).'@'.config('storeplix.platform_domain', 'storeplix.com');
    }

    // ---------------------------------------------------------------- HTTP + mapping

    private function client(PaymentGatewayAccount $account): PendingRequest
    {
        $base = $account->baseUrl() ?? throw new GatewayException(GatewayException::NOT_CONNECTED, 'SSLCommerz base URL is not configured.');

        return $this->http->to($base);
    }

    private function send(PaymentGatewayAccount $account, string $method, string $path, array $data, string $action, ?Payment $payment): Response
    {
        try {
            $request = $this->client($account);
            $response = $method === 'post' ? $request->asForm()->post($path, $data) : $request->get($path, $data);
        } catch (ConnectionException) {
            SafeHttpClient::log('sslcommerz', $action, null, ['payment_id' => $payment?->id, 'account_id' => $account->id]);
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "SSLCommerz {$action} timed out.");
        }
        SafeHttpClient::log('sslcommerz', $action, $response->status(), ['payment_id' => $payment?->id, 'account_id' => $account->id]);
        if ($response->serverError()) {
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, "SSLCommerz {$action} returned HTTP {$response->status()}.");
        }

        return $response;
    }

    /** @return array<string, mixed> */
    private function json(Response $response): array
    {
        $data = $response->json();

        return is_array($data) ? $data : [];
    }

    private function mapStatus(string $status): string
    {
        return match (strtoupper(trim($status))) {
            'VALID', 'VALIDATED' => Verification::SUCCEEDED,
            'PENDING', 'UNATTEMPTED', '' => Verification::PENDING,
            'CANCELLED' => Verification::CANCELLED,
            default => Verification::FAILED, // FAILED, EXPIRED, INVALID_TRANSACTION, …
        };
    }

    /** VERIFY against sandbox: query elements may name the currency `currency` instead of `currency_type`. */
    private function verification(array $body, string $providerStatus): Verification
    {
        $status = $this->mapStatus($providerStatus);
        $currency = $body['currency_type'] ?? $body['currency'] ?? null;

        return new Verification(
            $status,
            Money::tryFromDecimal($body['amount'] ?? null),
            is_string($currency) ? strtoupper($currency) : null,
            self::stringOrNull($body['tran_id'] ?? null),
            self::stringOrNull($body['bank_tran_id'] ?? null),
            in_array($status, [Verification::FAILED, Verification::CANCELLED], true) ? 'sslcommerz_'.self::code($providerStatus ?: 'unknown') : null,
            PayloadScrubber::scrub($body),
        );
    }

    private static function code(mixed $value): string
    {
        return strtolower(preg_replace('/[^A-Za-z0-9_]/', '', (string) $value) ?: 'unknown');
    }

    private static function stringOrNull(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : (is_int($value) ? (string) $value : null);
    }
}
