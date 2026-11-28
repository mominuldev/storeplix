<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\OrderMessages;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Inbox\WidgetService;
use App\Domain\Orders\Http\StorefrontOrderController;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\Response as BaseResponse;

/**
 * Order-page Messages (PHASE-8-8E §10): `X-Order-Access` (store-bound signed token) → the tracking view, the order's
 * customer / reply rows, a shopper message (the first creates the order conversation) and "seen". Channel off →
 * 404 `inbox_unavailable`; bad / expired token → 404 `order_access_invalid`.
 */
class StorefrontOrderMessagesController
{
    public const ACCESS_HEADER = 'X-Order-Access';

    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly OrderMessages $orders,
        private readonly WidgetService $widget,
        private readonly InboxVersion $version,
        private readonly StorefrontInboxController $chat,
    ) {}

    public static function orderStore(Request $request): StorefrontContext
    {
        $ctx = StorefrontInboxController::liveStore($request);
        if (! (bool) InboxSetting::query()->where('store_id', $ctx->store->id)->value('order_messages_enabled')) {
            throw new ApiException(404, 'inbox_unavailable', 'Order messages are not available for this shop.');
        }

        return $ctx;
    }

    /** GET /storefront/orders/access → StorefrontOrderTracking (same limited view as track) with `messages`. */
    public function access(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $order = $this->orders->order($ctx->store, $request->header(self::ACCESS_HEADER));

        return new JsonResponse(['data' => StorefrontOrderController::withMessages(OrderPresenter::tracking($order), $order, OrderAccessToken::TRACK_SECONDS)], 200, self::NO_STORE);
    }

    public function messages(Request $request): BaseResponse
    {
        $ctx = self::orderStore($request);
        $order = $this->orders->order($ctx->store, $request->header(self::ACCESS_HEADER));
        $after = StorefrontInboxController::after($request);
        $etag = $this->version->etag($ctx->store->id, null, ['order', $order->id, $after]);
        if (($hit = InboxVersion::notModified($request, $etag)) !== null) {
            return $hit;
        }

        return InboxVersion::respond(['data' => StorefrontInboxController::thread($this->orders->conversation($order), $after, $ctx->store)], $etag);
    }

    public function send(Request $request): JsonResponse
    {
        $ctx = self::orderStore($request);
        $order = $this->orders->order($ctx->store, $request->header(self::ACCESS_HEADER));
        [$body, $clientId] = StorefrontInboxController::shopperInput($request);
        $file = $this->chat->upload($request, $ctx->store);
        [$message, $conversation] = $this->orders->send($ctx->store, $order, $body, $file, $clientId);

        return new JsonResponse(['data' => StorefrontInboxController::shopperShape($message, $conversation, $ctx->store)], 201, self::NO_STORE);
    }

    public function seen(Request $request): Response
    {
        $ctx = self::orderStore($request);
        $conversation = $this->orders->conversation($this->orders->order($ctx->store, $request->header(self::ACCESS_HEADER)));
        if ($conversation !== null) {
            $this->widget->seen($conversation);
        }

        return new Response('', 204, self::NO_STORE);
    }
}
