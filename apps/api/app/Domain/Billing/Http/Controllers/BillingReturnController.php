<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\BillingUrls;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Tenancy\Support\PreTenantLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * §6.2 / B22: platform gateway browser returns. Public (no session, no tenant header, no CSRF): the signed URL names
 * the payment, `sp_billing_payment_owner()` its tenant. The params are a TRIGGER only (S53). Always a 303 to
 * `{MERCHANT_APP_URL}/settings/plan?payment={id}`; a bad signature or unknown id → `?payment_error=1` (S59).
 */
class BillingReturnController
{
    public function __construct(
        private readonly PreTenantLookup $lookup,
        private readonly TenantContext $context,
        private readonly BillingPaymentService $payments,
    ) {}

    public function __invoke(Request $request, string $provider, string $payment): Response
    {
        $payment = strtolower($payment);
        if (! BillingUrls::hasValidReturnSignature($request, $provider, $payment)) {
            return self::redirect(null);
        }
        $tenantId = $this->lookup->billingPaymentOwner($payment);
        if ($tenantId === null) {
            return self::redirect(null);
        }

        return $this->context->run($tenantId, function () use ($request, $provider, $payment) {
            $row = BillingPayment::query()->find($payment);
            if ($row === null || $row->provider !== $provider) {
                return self::redirect(null);
            }
            $params = array_filter($request->query() + $request->post(), fn ($v, $k) => is_string($k) && is_scalar($v), ARRAY_FILTER_USE_BOTH);
            $this->payments->handleReturn($row, $params);

            return self::redirect($row->id);
        });
    }

    private static function redirect(?string $paymentId): Response
    {
        return new Response('', 303, ['Location' => BillingUrls::merchantResult($paymentId), 'Cache-Control' => 'no-store', 'Referrer-Policy' => 'no-referrer']);
    }
}
