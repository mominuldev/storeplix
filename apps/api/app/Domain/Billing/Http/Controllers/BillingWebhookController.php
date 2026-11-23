<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\Gateways\SslCommerzBillingGateway;
use App\Domain\Billing\Jobs\ProcessBillingIpn;
use App\Domain\Tenancy\Support\PreTenantLookup;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * §6.2 / P7-12 / B23 / S55: the ONE platform SSLCommerz IPN URL. Always 200 `{data:{received:true}}` (identical body
 * whatever happened). verify_sign with the PLATFORM store_passwd; then tran_id → tenant → ProcessBillingIpn (queue
 * `billing`), where the Validation API decides. Nothing is stored for a bad sign or an unknown tran_id.
 */
class BillingWebhookController
{
    public function __construct(private readonly PreTenantLookup $lookup) {}

    public function sslcommerz(Request $request): JsonResponse
    {
        $params = array_filter($request->post(), fn ($v, $k) => is_string($k) && is_scalar($v), ARRAY_FILTER_USE_BOTH);
        if (! SslCommerzBillingGateway::verifyIpn($params)) {
            Log::warning('billing.ipn_invalid');

            return self::ack();
        }
        $tranId = is_string($params['tran_id'] ?? null) ? strtolower(trim($params['tran_id'])) : '';
        $tenantId = $tranId !== '' ? $this->lookup->billingPaymentOwner($tranId) : null;
        if ($tenantId !== null) {
            $valId = is_string($params['val_id'] ?? null) && strlen($params['val_id']) <= 128 ? $params['val_id'] : null;
            ProcessBillingIpn::dispatch($tranId, $valId, $tenantId);
        }

        return self::ack();
    }

    private static function ack(): JsonResponse
    {
        return new JsonResponse(['data' => ['received' => true]], 200, ['Cache-Control' => 'no-store']);
    }
}
