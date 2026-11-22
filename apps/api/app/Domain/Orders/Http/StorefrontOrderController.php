<?php

namespace App\Domain\Orders\Http;

use App\Domain\Cart\CartService;
use App\Domain\Cart\Http\StorefrontCartController;
use App\Domain\Geo\AddressValidator;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** §3.4 checkout, confirmation and tracking (storefront, server-to-server). All responses `private, no-store`. */
class StorefrontOrderController
{
    public const ORDER_TOKEN_HEADER = 'X-Order-Token';

    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly OrderPlacementService $placement,
        private readonly AddressValidator $addresses,
    ) {}

    public function checkout(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request);
        if (! $ctx->isLive()) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Orders open after you go live.");
        }
        $token = (string) $request->header(StorefrontCartController::TOKEN_HEADER, '');
        if ($token === '') {
            throw CartService::notFound();
        }
        $input = $request->validate([
            ...OrderController::contactRules(),
            ...AddressValidator::rules('shipping_address'),
            'payment_method' => ['required', 'string', 'max:24'],
            'customer_note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'accepts_marketing' => ['sometimes', 'boolean'],
            'expected_total_amount' => ['required', 'integer:strict', 'min:0'],
        ]);

        $result = $this->placement->checkout($ctx->store, $token, [
            'contact' => OrderController::contact($input['contact']),
            'address' => $this->addresses->snapshot($input['shipping_address']),
            'payment_method' => $input['payment_method'],
            'customer_note' => AddressValidator::clean($input['customer_note'] ?? null),
            'accepts_marketing' => (bool) ($input['accepts_marketing'] ?? false),
            'expected_total' => $input['expected_total_amount'],
            'idempotency_key' => $request->header(IdempotencyGuard::HEADER),
            'ip' => $ctx->clientIp,
            'user_agent' => null,
        ]);

        return new JsonResponse(['data' => [
            'order' => OrderPresenter::storefront($result['order']->refresh()),
            'confirmation_token' => $result['token'],
        ]], 201, self::NO_STORE);
    }

    public function confirmation(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $token = (string) $request->header(self::ORDER_TOKEN_HEADER, '');
        $order = $token === '' || strlen($token) > 64 ? null : Order::query()->where('store_id', $ctx->store->id)
            ->where('confirmation_token_hash', hash('sha256', $token))->where('confirmation_expires_at', '>', now())->first();
        if ($order === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return new JsonResponse(['data' => OrderPresenter::storefront($order)], 200, self::NO_STORE);
    }

    /** Number (with or without prefix, any case) + phone; any mismatch is the same 404 as an unknown number (S8). */
    public function track(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $input = $request->validate([
            'number' => ['required', 'string', 'max:24'],
            'phone' => ['required', 'string', 'max:20'],
        ]);
        $phone = Phone::bdMsisdn($input['phone']);
        $number = strtoupper(trim($input['number']));
        $digits = preg_match('/^(?:[A-Z]{1,6}-?)?(\d{1,18})$/', $number, $m) === 1 ? (int) $m[1] : null;

        $order = null;
        if ($phone !== null && $digits !== null) {
            $candidate = Order::query()->where('store_id', $ctx->store->id)->where('sequence', $digits)->first();
            $prefixOk = $candidate !== null && (ctype_digit($number) || strtoupper($candidate->number) === $number
                || strtoupper(str_replace('-', '', $candidate->number)) === $number);
            if ($candidate !== null && $prefixOk && hash_equals($candidate->customer_phone, $phone)) {
                $order = $candidate;
            }
        }
        if ($order === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return new JsonResponse(['data' => OrderPresenter::tracking($order)], 200, self::NO_STORE);
    }
}
