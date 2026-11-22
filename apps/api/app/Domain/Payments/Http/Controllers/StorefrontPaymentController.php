<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Http\StorefrontOrderController;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Payments\PaymentService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** §4.2 storefront payments (server-to-server). All responses `private, no-store`; no shopper PII in results. */
class StorefrontPaymentController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly PaymentService $payments,
        private readonly PaymentLinkService $links,
    ) {}

    /** POST /storefront/orders/pay (P5B-17): retry online or switch to COD while the hold is open. */
    public function pay(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $order = StorefrontOrderController::orderByToken($request, $ctx->store->id);
        $input = $request->validate(['payment_method' => ['required', 'string', 'in:cod,bkash,sslcommerz']]);
        $result = $this->payments->retry($order, $input['payment_method']);
        $order = $result['order']->refresh();

        return new JsonResponse(['data' => [
            'order' => OrderPresenter::storefront($order),
            'payment' => $result['payment'],
        ]], 200, self::NO_STORE);
    }

    /** GET /storefront/payments/{payment}/result: no order token needed, so nothing personal in it. */
    public function result(Request $request, string $payment): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $payment) === 1
            ? Payment::query()->where('store_id', $ctx->store->id)->whereKey(strtolower($payment))->where('type', Payment::TYPE_CHARGE)
                ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('purpose', '<>', Payment::PURPOSE_TEST)->first()
            : null;
        if ($row === null) {
            throw self::notFound();
        }

        return new JsonResponse(['data' => PaymentPresenter::storefrontResult($row, $ctx->store)], 200, self::NO_STORE);
    }

    /** GET /storefront/payment-links/{token}: unknown, expired, paid and cancelled → one identical 404 (S28). */
    public function showLink(Request $request, string $token): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $link = PaymentLinkService::byToken($ctx->store->id, $token);
        $order = $link !== null ? Order::query()->find($link->order_id) : null;
        if ($link === null || $order === null || ! PaymentLinkService::payable($link, $order) || $this->payments->usableAccount($ctx->store->id, $link->provider) === null) {
            throw self::notFound();
        }

        return new JsonResponse(['data' => PaymentPresenter::linkView($link, $order, $ctx->store)], 200, self::NO_STORE + ['X-Robots-Tag' => 'noindex']);
    }

    /** POST /storefront/payment-links/{token}/pay → PaymentInitiation. */
    public function payLink(Request $request, string $token): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $link = PaymentLinkService::byToken($ctx->store->id, $token);
        if ($link === null) {
            throw self::notFound();
        }

        $initiation = $this->links->pay($link);
        if ($initiation['status'] !== 'redirect') {
            throw new ApiException(502, 'provider_unavailable', 'The payment provider didn’t answer. Try again in a minute.');
        }

        return new JsonResponse(['data' => $initiation], 200, self::NO_STORE);
    }

    private static function notFound(): ApiException
    {
        return new ApiException(404, 'not_found', 'Resource not found.');
    }
}
