<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Controllers;

use App\Domain\FraudGuard\CheckoutOtpService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-8 §7 POST /storefront/checkout/otp `{phone}` → CheckoutOtpResponse (same shape for blocked, known and
 * unknown numbers; the code is never in a response). Limiter `checkout-otp`; unknown fields are ignored.
 */
class StorefrontCheckoutOtpController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly CheckoutOtpService $otp) {}

    public function send(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request);
        if (! $ctx->isLive()) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Orders open after you go live.");
        }
        $input = $request->validate(['phone' => ['required', 'string', 'max:20', PhoneRule::bdMobile()]]);

        return new JsonResponse(['data' => $this->otp->send($ctx->store, (string) Phone::bdMsisdn($input['phone']), $ctx->clientIp)], 200, self::NO_STORE);
    }
}
