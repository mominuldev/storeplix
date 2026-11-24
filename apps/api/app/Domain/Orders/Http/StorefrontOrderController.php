<?php

namespace App\Domain\Orders\Http;

use App\Domain\Cart\CartService;
use App\Domain\Cart\Http\StorefrontCartController;
use App\Domain\FraudGuard\FraudGuard;
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
        private readonly FraudGuard $guard,
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
            'advance_gateway' => ['sometimes', 'nullable', 'string', 'max:24'],
            'customer_note' => ['sometimes', 'nullable', 'string', 'max:500'],
            'accepts_marketing' => ['sometimes', 'boolean'],
            'expected_total_amount' => ['required', 'integer:strict', 'min:0'],
            // PHASE-8-8 P88-13: the shopper's checkout code (new numbers on COD of a guarded store).
            'otp_code' => ['sometimes', 'nullable', 'string', 'regex:/^\d{6}$/'],
        ]);
        $contact = OrderController::contact($input['contact']);
        // PHASE-8-8 §7: blocklist / daily limit / OTP for COD, before any stock is reserved (422s; online passes).
        $flags = $this->guard->beforeCheckout($ctx->store, $contact['phone'], (string) $input['payment_method'], $input['otp_code'] ?? null);

        $result = $this->placement->checkout($ctx->store, $token, [
            'contact' => $contact,
            'address' => $this->addresses->snapshot($input['shipping_address']),
            'payment_method' => $input['payment_method'],
            'guard_flags' => $flags,
            'advance_gateway' => $input['advance_gateway'] ?? null,
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
            'payment' => $result['payment'],
        ]], 201, self::NO_STORE);
    }

    public function confirmation(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $order = self::orderByToken($request, $ctx->store->id);

        return new JsonResponse(['data' => OrderPresenter::storefront($order)], 200, self::NO_STORE);
    }

    /** The order behind X-Order-Token (thank-you page cookie `sp_order`), else 404. */
    public static function orderByToken(Request $request, string $storeId): Order
    {
        $token = (string) $request->header(self::ORDER_TOKEN_HEADER, '');
        $order = $token === '' || strlen($token) > 64 ? null : Order::query()->where('store_id', $storeId)
            ->where('confirmation_token_hash', hash('sha256', $token))->where('confirmation_expires_at', '>', now())->first();

        return $order ?? throw new ApiException(404, 'not_found', 'Resource not found.');
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
