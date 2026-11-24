<?php

declare(strict_types=1);

namespace App\Domain\Cart\Http;

use App\Domain\Automations\Engine\RecoveryLinks;
use App\Domain\Cart\CartService;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-6 §7 storefront checkout recovery (server-to-server; tenant from the validated host + key; draft stores 404).
 *  - PUT /storefront/cart/contact (X-Cart-Token): the checkout contact → 204; the contact is never echoed (S132).
 *  - POST /storefront/carts/recover {code} → 201 {cart_token, next}; the raw token is returned once (S133).
 * Limiters per shopper IP (X-Storefront-Client-Ip): 10/min and 20/min.
 */
class StorefrontCartRecoveryController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly CartService $carts) {}

    public function contact(Request $request): Response
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate([
            'phone' => ['required', 'string', 'max:20'],
            'name' => ['sometimes', 'nullable', 'string', 'max:80', 'not_regex:/[\x00-\x1F\x7F]/'],
            'email' => ['sometimes', 'nullable', 'string', 'email:rfc', 'max:254'],
        ]);
        $phone = Phone::bdMsisdn($input['phone']);
        if ($phone === null) {
            throw ValidationException::withMessages(['phone' => ['Enter a valid Bangladeshi mobile number.']]);
        }
        $token = $request->header(StorefrontCartController::TOKEN_HEADER);
        $cart = $this->carts->require($ctx->store, is_string($token) && $token !== '' ? $token : null, lock: false);
        if (! $cart->items()->exists()) {
            throw CartService::notFound();
        }
        $contact = ['phone' => $phone];
        if (array_key_exists('name', $input)) {
            $contact['name'] = $input['name'] !== null && trim($input['name']) !== '' ? trim($input['name']) : null;
        }
        if (array_key_exists('email', $input)) {
            $contact['email'] = $input['email'] !== null ? mb_strtolower(trim($input['email'])) : null;
        }
        $this->carts->saveContact($cart, $contact);

        return response()->noContent(204, self::NO_STORE);
    }

    public function recover(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate(['code' => ['required', 'string', 'max:64']]);

        return new JsonResponse(['data' => RecoveryLinks::restore($ctx->store, $input['code'], $ctx->clientIp)], 201, self::NO_STORE);
    }
}
