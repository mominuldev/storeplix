<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;

/**
 * URLs of the online-payment flow (P5B-18, P5B-19, P5B-22).
 *
 * Return URLs are Laravel signed routes (26 h) built RELATIVE and prefixed with PUBLIC_API_URL, so a tunnel host in
 * sandbox work doesn't break the signature. Verification reads the FIRST `expires` / `signature` of the raw query
 * string: bKash appends its own `paymentID`, `status` and `signature` parameters to the callback URL, and PHP's
 * `$_GET` would keep bKash's (last) `signature`. The SSLCommerz `r=success|fail|cancel` hint is outside the
 * signature: it is only a trigger, verification decides (P5B-16).
 *
 * Redirects after a return go ONLY to the store's primary host from the DB, never to a URL from the request (S29).
 */
final class PaymentUrls
{
    public const RETURN_ROUTE = 'payments.return';

    public const RETURN_TTL_HOURS = 26;

    public static function returnUrl(Payment $payment): string
    {
        $relative = URL::temporarySignedRoute(self::RETURN_ROUTE, now()->addHours(self::RETURN_TTL_HOURS), [
            'provider' => $payment->provider,
            'payment' => $payment->id,
        ], absolute: false);

        return self::apiBase().$relative;
    }

    /** SSLCommerz IPN URL of an account (P5B-19). */
    public static function ipnUrl(PaymentGatewayAccount $account): string
    {
        return self::apiBase().'/api/v1/webhooks/'.$account->provider.'/'.$account->route_key;
    }

    /** True when the request carries a valid, unexpired signature for this provider + payment. */
    public static function hasValidReturnSignature(Request $request, string $provider, string $paymentId): bool
    {
        $query = self::firstQueryValues((string) $request->server->get('QUERY_STRING', ''));
        $expires = $query['expires'] ?? null;
        $signature = $query['signature'] ?? null;
        if ($expires === null || $signature === null || ! ctype_digit($expires) || preg_match('/^[0-9a-f]{64}$/', $signature) !== 1) {
            return false;
        }
        $path = route(self::RETURN_ROUTE, ['provider' => $provider, 'payment' => $paymentId], false);
        $clean = Request::create($path.'?expires='.$expires.'&signature='.$signature);

        return URL::hasValidSignature($clean, absolute: false);
    }

    /** @return array<string, string> first occurrence of each key (raw query string) */
    public static function firstQueryValues(string $queryString): array
    {
        $values = [];
        foreach (explode('&', $queryString) as $pair) {
            if ($pair === '') {
                continue;
            }
            [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
            $key = urldecode($key);
            if (! array_key_exists($key, $values)) {
                $values[$key] = urldecode($value);
            }
        }

        return $values;
    }

    /** https://{primary host} (local: http://{host}:3010, like preview links). Null when the store has no primary domain. */
    public static function storefrontBase(Store $store): ?string
    {
        $host = $store->relationLoaded('primaryDomain') ? $store->primaryDomain?->hostname
            : StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->value('hostname');
        if (! is_string($host) || $host === '') {
            return null;
        }

        return app()->environment('local') ? "http://{$host}:3010" : "https://{$host}";
    }

    /** Where the shopper lands after a gateway return (P5B-18). */
    public static function resultUrl(Store $store, Payment $payment): ?string
    {
        if ($payment->purpose === Payment::PURPOSE_TEST) {
            return rtrim((string) config('storeplix.merchant_app_url'), '/').'/settings/payments?test_payment='.$payment->id;
        }
        $base = self::storefrontBase($store);
        if ($base === null) {
            return null;
        }
        $path = $payment->purpose === Payment::PURPOSE_LINK ? '/pay/result' : '/checkout/payment-result';

        return $base.$path.'?payment='.$payment->id;
    }

    /** https://{primary_host}/pay/{token} (Q55). */
    public static function linkUrl(Store $store, string $token): string
    {
        return (self::storefrontBase($store) ?? '').'/pay/'.$token;
    }

    private static function apiBase(): string
    {
        return rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/');
    }
}
