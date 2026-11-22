<?php

namespace App\Domain\Cart\Http;

use App\Domain\Cart\CartService;
use App\Domain\Cart\Models\Cart;
use App\Domain\Geo\BdGeo;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * §3.3 storefront cart (server-to-server; X-Cart-Token). Every response is `private, no-store`. The raw token is only
 * ever returned once, in meta.cart_token of the request that created the cart.
 */
class StorefrontCartController
{
    public const TOKEN_HEADER = 'X-Cart-Token';

    public function __construct(private readonly CartService $carts) {}

    public function show(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();

        return $this->respond($ctx, $this->carts->require($ctx->store, $this->token($request)));
    }

    public function addItem(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate([
            'variant_id' => ['required', 'string', 'max:26'],
            'quantity' => ['required', 'integer:strict', 'min:1', 'max:'.Cart::MAX_QUANTITY],
        ]);
        $cart = $this->carts->find($ctx->store, $this->token($request));
        $this->carts->assertAddable($ctx->store, $cart, $input['variant_id'], $input['quantity'], $ctx->preview);

        $token = null;
        if ($cart === null) {
            [$cart, $token] = $this->carts->create($ctx->store, $ctx->clientIp);
        }
        $this->carts->addItem($ctx->store, $cart, $input['variant_id'], $input['quantity']);

        return $this->respond($ctx, $cart, $token !== null ? 201 : 200, $token);
    }

    public function updateItem(Request $request, string $item): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate(['quantity' => ['required', 'integer:strict', 'min:1', 'max:'.Cart::MAX_QUANTITY]]);
        $cart = $this->carts->require($ctx->store, $this->token($request));
        $this->carts->updateItem($ctx->store, $cart, $this->carts->findItem($cart, $item), $input['quantity'], $ctx->preview);

        return $this->respond($ctx, $cart);
    }

    public function removeItem(Request $request, string $item): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $cart = $this->carts->require($ctx->store, $this->token($request));
        $this->carts->removeItem($cart, $this->carts->findItem($cart, $item));

        return $this->respond($ctx, $cart);
    }

    public function applyCoupon(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate(['code' => ['required', 'string', 'max:32']]);
        $cart = $this->carts->require($ctx->store, $this->token($request));
        $this->carts->applyCoupon($ctx->store, $cart, $input['code'], $ctx->preview);

        return $this->respond($ctx, $cart);
    }

    public function removeCoupon(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $cart = $this->carts->require($ctx->store, $this->token($request));
        $this->carts->removeCoupon($cart);

        return $this->respond($ctx, $cart);
    }

    public function shippingOptions(Request $request, BdGeo $geo): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate([
            'district_code' => ['required', 'string', 'max:32'],
            'thana_code' => ['required', 'string', 'max:48'],
        ]);
        if ($geo->district($input['district_code']) === null) {
            throw ValidationException::withMessages(['district_code' => ['Choose a district.']]);
        }
        if (! $geo->thanaInDistrict($input['district_code'], $input['thana_code'])) {
            throw ValidationException::withMessages(['thana_code' => ['Choose a thana or upazila in this district.']]);
        }
        $cart = $this->carts->require($ctx->store, $this->token($request));

        return new JsonResponse(
            ['data' => $this->carts->shippingQuote($ctx->store, $cart, $input['district_code'], $input['thana_code'], $ctx->preview)],
            200,
            ['Cache-Control' => 'private, no-store'],
        );
    }

    private function token(Request $request): ?string
    {
        $token = $request->header(self::TOKEN_HEADER);

        return is_string($token) && $token !== '' ? $token : null;
    }

    private function respond(StorefrontContext $ctx, Cart $cart, int $status = 200, ?string $token = null): JsonResponse
    {
        $view = $this->carts->view($ctx->store, $cart, $ctx->preview);
        $meta = [];
        if ($token !== null) {
            $meta['cart_token'] = $token;
        }
        if ($view['notices'] !== []) {
            $meta['notices'] = $view['notices'];
        }

        return new JsonResponse(['data' => $view['data'], 'meta' => (object) $meta], $status, ['Cache-Control' => 'private, no-store']);
    }
}
