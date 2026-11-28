<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Inbox\Support\ThreadKey;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Order-page Messages (PHASE-8-8E §10, P88E-21): holding order access (confirmation token or tracking number + phone)
 * is the shopper's identity. The stateless store-bound token travels in `X-Order-Access`; the first message creates the
 * `order` conversation (contact from the order snapshot, customer + order linked). Inside the tenant context.
 */
final class OrderMessages
{
    public function __construct(
        private readonly ConversationService $conversations,
        private readonly InboxAttachments $attachments,
        private readonly TenantContext $context,
    ) {}

    /**
     * `StorefrontOrderTracking.messages` (§10): null when the channel is off (or a till sale).
     *
     * @return array{enabled: true, access_token: string, unread_count: int, reply_time: string}|null
     */
    public static function access(Order $order, int $ttlSeconds): ?array
    {
        $settings = InboxSetting::query()->where('store_id', $order->store_id)->first();
        if ($settings === null || ! $settings->order_messages_enabled || $order->created_via === Order::VIA_POS) {
            return null;
        }
        $conversation = InboxConversation::query()->where('store_id', $order->store_id)->where('channel', InboxConversation::ORDER)
            ->where('thread_key', ThreadKey::order($order->id))->first();

        return [
            'enabled' => true,
            'access_token' => OrderAccessToken::issue($order->tenant_id, $order->store_id, $order->id, $ttlSeconds),
            'unread_count' => InboxQuery::shopperUnread($conversation),
            'reply_time' => $settings->widget_reply_time,
        ];
    }

    /** The order behind a valid `X-Order-Access` of this store, else 404 `order_access_invalid`. */
    public function order(Store $store, ?string $token): Order
    {
        $orderId = OrderAccessToken::verify($token, $this->context->requireId(), $store->id);
        $order = $orderId === null ? null : Order::query()->where('store_id', $store->id)->whereKey($orderId)->where('created_via', '<>', Order::VIA_POS)->first();

        return $order ?? throw new ApiException(404, 'order_access_invalid', 'This order link has expired. Track your order again.');
    }

    public function conversation(Order $order): ?InboxConversation
    {
        return InboxConversation::query()->where('store_id', $order->store_id)->where('channel', InboxConversation::ORDER)
            ->where('thread_key', ThreadKey::order($order->id))->first();
    }

    /** @return array{0: InboxMessage, 1: InboxConversation} */
    public function send(Store $store, Order $order, string $body, ?InboxAttachment $file, string $clientId): array
    {
        return DB::transaction(function () use ($store, $order, $body, $file, $clientId) {
            $conversation = $this->conversations->lockOrCreate($store->id, InboxConversation::ORDER, ThreadKey::order($order->id), [
                'identity' => InboxConversation::ORDER_ACCESS,
                'contact_name' => $order->customer_name,
                'contact_phone' => $order->customer_phone !== '' ? $order->customer_phone : null,
                'contact_email' => $order->customer_email,
                'customer_id' => $order->customer_id,
                'order_id' => $order->id,
            ]);
            $files = $file === null ? new Collection : $this->attachments->claim([$file->id], $store->id, null, null, 'file');

            return [$this->conversations->appendCustomer($conversation, $body, $files, $clientId) ?? WidgetService::swallowed($conversation, $body), $conversation];
        });
    }
}
