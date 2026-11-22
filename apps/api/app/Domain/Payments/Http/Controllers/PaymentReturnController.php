<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\PaymentService;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\IntegrationLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\Response as BaseResponse;

/**
 * Gateway browser returns (P5B-18, §4.3, S22, S29). Public, no tenant header: the signed URL names the payment, the
 * definer function names its tenant. The query/body is a TRIGGER only (verification is server-side, P5B-16). Always
 * a 303 to the store's primary host from the DB; a bad or expired signature gets a 403 page and no redirect.
 */
class PaymentReturnController
{
    public function __construct(
        private readonly IntegrationLookup $lookup,
        private readonly TenantContext $context,
        private readonly PaymentService $payments,
    ) {}

    public function __invoke(Request $request, string $provider, string $payment): BaseResponse
    {
        $payment = strtolower($payment);
        if (! PaymentUrls::hasValidReturnSignature($request, $provider, $payment)) {
            return self::page(403, 'This payment link has expired', 'Go back to the shop and try again.');
        }
        $owner = $this->lookup->paymentOwner($payment);
        if ($owner === null) {
            return self::page(404, 'Payment not found', 'Go back to the shop and try again.');
        }

        return $this->context->run($owner['tenant_id'], function () use ($request, $provider, $payment, $owner) {
            $row = Payment::query()->where('store_id', $owner['store_id'])->whereKey($payment)->first();
            if ($row === null || $row->provider !== $provider || $row->type !== Payment::TYPE_CHARGE) {
                return self::page(404, 'Payment not found', 'Go back to the shop and try again.');
            }
            $params = array_filter($request->query() + $request->post(), fn ($v, $k) => is_string($k) && is_scalar($v), ARRAY_FILTER_USE_BOTH);
            $this->payments->handleReturn($row, self::outcome($params), $params);

            $store = Store::query()->with('primaryDomain')->findOrFail($owner['store_id']);
            $target = PaymentUrls::resultUrl($store, $row);
            if ($target === null) {
                return self::page(200, 'Thank you', 'You can close this page and go back to the shop.');
            }

            return new Response('', 303, ['Location' => $target, 'Cache-Control' => 'no-store', 'Referrer-Policy' => 'no-referrer']);
        });
    }

    /**
     * success | failure | cancel from bKash `status`, the SSLCommerz `r` hint (first occurrence) or its POSTed
     * `status` (VALID / FAILED / CANCELLED / …). Unknown values count as success: that only triggers verification.
     *
     * @param  array<string, scalar>  $params
     */
    public static function outcome(array $params): string
    {
        $value = strtolower((string) ($params['r'] ?? $params['status'] ?? 'success'));

        return match ($value) {
            'failure', 'fail', 'failed', 'unattempted', 'expired' => 'failure',
            'cancel', 'cancelled', 'canceled' => 'cancel',
            default => 'success',
        };
    }

    private static function page(int $status, string $title, string $body): Response
    {
        $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">'
            .'<meta name="viewport" content="width=device-width,initial-scale=1"><title>'.e($title).'</title></head>'
            .'<body style="font-family:Inter,Arial,sans-serif;color:#0d0d18;max-width:480px;margin:64px auto;padding:0 16px">'
            .'<h1 style="font-size:20px">'.e($title).'</h1><p>'.e($body).'</p></body></html>';

        return new Response($html, $status, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store']);
    }
}
