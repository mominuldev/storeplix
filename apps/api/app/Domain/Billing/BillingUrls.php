<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\PaymentUrls;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;

/**
 * P7-12 URLs. The return URL is a signed relative route (26 h) prefixed with PUBLIC_API_URL; its signature is read
 * from the FIRST `expires`/`signature` of the raw query (bKash appends its own params, PaymentUrls rule). After a
 * return the browser goes ONLY to `{MERCHANT_APP_URL}/settings/plan?payment={id}` (S59), never to a request value.
 */
final class BillingUrls
{
    public const RETURN_ROUTE = 'billing.payments.return';

    public static function returnUrl(BillingPayment $payment): string
    {
        $relative = URL::temporarySignedRoute(self::RETURN_ROUTE, now()->addHours(PaymentUrls::RETURN_TTL_HOURS), [
            'provider' => $payment->provider,
            'payment' => $payment->id,
        ], absolute: false);

        return self::apiBase().$relative;
    }

    public static function ipnUrl(): string
    {
        return self::apiBase().'/api/v1/billing/webhooks/sslcommerz';
    }

    public static function hasValidReturnSignature(Request $request, string $provider, string $paymentId): bool
    {
        $query = PaymentUrls::firstQueryValues((string) $request->server->get('QUERY_STRING', ''));
        $expires = $query['expires'] ?? null;
        $signature = $query['signature'] ?? null;
        if ($expires === null || $signature === null || ! ctype_digit($expires) || preg_match('/^[0-9a-f]{64}$/', $signature) !== 1) {
            return false;
        }
        $path = route(self::RETURN_ROUTE, ['provider' => $provider, 'payment' => $paymentId], false);

        return URL::hasValidSignature(Request::create($path.'?expires='.$expires.'&signature='.$signature), absolute: false);
    }

    /** PHASE-8-9A §5.3: `sms_credits` invoices return to `/integrations/sms?tab=credits&payment={id}`. */
    public static function merchantResult(?string $paymentId, ?string $kind = null): string
    {
        $app = rtrim((string) config('storeplix.merchant_app_url'), '/');
        if ($paymentId !== null && $kind === BillingInvoice::SMS_CREDITS) {
            return $app.'/integrations/sms?tab=credits&payment='.$paymentId;
        }
        $base = $app.'/settings/plan';

        return $paymentId !== null ? $base.'?payment='.$paymentId : $base.'?payment_error=1';
    }

    /** S59: a provider page must be https on a configured provider host; the fake page is the API's own origin. */
    public static function allowedRedirect(string $provider, string $url): bool
    {
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if ((bool) config('billing.fake')) {
            $own = [strtolower((string) parse_url((string) config('app.url'), PHP_URL_HOST)), strtolower((string) parse_url(self::apiBase(), PHP_URL_HOST))];

            return in_array($scheme, ['http', 'https'], true) && $host !== '' && (in_array($host, $own, true) || $host === 'localhost' || str_ends_with($host, '.localhost'));
        }
        $hosts = (array) config("billing.redirect_hosts.{$provider}", []);

        return $scheme === 'https' && in_array($host, $hosts, true);
    }

    private static function apiBase(): string
    {
        return rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/');
    }
}
