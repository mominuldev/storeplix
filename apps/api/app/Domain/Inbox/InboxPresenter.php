<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Catalog\Models\Product;
use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\RiskTier;
use App\Domain\Identity\Models\User;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxRead;
use App\Domain\Inbox\Models\InboxSavedReply;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * API shapes of the Inbox (openapi 1.25.0 tag `inbox`; packages/types "Inbox"). Bodies are plain text (P88E-23).
 * Shopper shapes (§9.2) only ever carry customer / reply rows (S236).
 */
final class InboxPresenter
{
    /**
     * Attachment shapes keyed by message id (one query for the attachments, one for their media status).
     *
     * @param  list<string>  $messageIds
     * @return array<string, list<array<string, mixed>>>
     */
    public static function attachmentsFor(array $messageIds): array
    {
        if ($messageIds === []) {
            return [];
        }
        $rows = InboxAttachment::query()->whereIn('message_id', $messageIds)->orderBy('id')->get();
        $status = Media::query()->whereIn('id', $rows->pluck('media_id')->all())->pluck('status', 'id');
        $out = [];
        foreach ($rows as $row) {
            if (($status[$row->media_id] ?? Media::FAILED) === Media::FAILED) {
                continue;
            }
            $out[$row->message_id][] = self::attachment($row, (string) $status[$row->media_id]);
        }

        return $out;
    }

    /** @return array<string, mixed> InboxAttachment */
    public static function attachment(InboxAttachment $row, ?string $mediaStatus = null): array
    {
        $mediaStatus ??= (string) Media::query()->whereKey($row->media_id)->value('status');

        return [
            'id' => $row->id,
            'filename' => $row->filename,
            'mime' => $row->mime,
            'size_bytes' => (int) $row->size_bytes,
            'kind' => InboxAttachments::kind($row->mime),
            'status' => $mediaStatus === Media::READY ? 'ready' : 'processing',
        ];
    }

    /** @param array<string, User> $users @return array<string, mixed>|null */
    private static function userRef(?string $id, array $users): ?array
    {
        return $id === null || ! isset($users[$id]) ? null : UserRef::of($users[$id]);
    }

    /** @param iterable<string|null> $ids @return array<string, User> */
    public static function users(iterable $ids): array
    {
        $ids = collect($ids)->filter()->unique()->values()->all();

        return $ids === [] ? [] : User::query()->whereIn('id', $ids)->get()->keyBy('id')->all();
    }

    /** @return array<string, mixed> InboxContact */
    public static function contact(InboxConversation $c): array
    {
        return ['name' => $c->contact_name, 'phone' => InboxText::localPhone($c->contact_phone), 'email' => $c->contact_email];
    }

    /**
     * @param  array<string, User>  $users
     * @param  array<string, string>  $orderNumbers
     * @return array<string, mixed> InboxConversationSummary
     */
    public static function summaryRow(InboxConversation $c, array $users, array $orderNumbers, int $unread): array
    {
        return [
            'id' => $c->id,
            'channel' => $c->channel,
            'status' => $c->status,
            'identity' => $c->identity,
            'contact' => self::contact($c),
            'order' => $c->order_id !== null && isset($orderNumbers[$c->order_id]) ? ['id' => $c->order_id, 'number' => $orderNumbers[$c->order_id]] : null,
            'preview' => $c->preview,
            'last_message_at' => UserRef::iso($c->last_message_at),
            'assignee' => self::userRef($c->assignee_id, $users),
            'unread_count' => min(99, $unread),
            'blocked' => $c->isBlocked(),
        ];
    }

    /** @return array<string, mixed> InboxConversation */
    public static function conversation(InboxConversation $c, PermissionSet $permissions, int $unread): array
    {
        $users = self::users([$c->assignee_id, $c->closed_by]);
        $order = $c->order_id !== null ? Order::query()->whereKey($c->order_id)->first() : null;
        $base = self::summaryRow($c, $users, $order !== null ? [$order->id => $order->number] : [], $unread);
        $first = $c->first_response_at !== null
            ? InboxMessage::query()->where('conversation_id', $c->id)->where('kind', InboxMessage::CUSTOMER)->orderBy('id')->value('created_at')
            : null;
        $firstAt = $first !== null ? Carbon::parse($first) : null;
        $canOrders = $permissions->has(Permission::OrdersView);

        return $base + [
            'subject' => $c->subject,
            'context' => $c->context,
            'source_path' => $c->source_path,
            'started_at' => UserRef::iso($c->created_at),
            'first_response_seconds' => $firstAt !== null && $c->first_response_at !== null ? max(0, (int) $firstAt->diffInSeconds($c->first_response_at, true)) : null,
            'customer_seen_at' => UserRef::iso($c->customer_seen_at),
            'closed_at' => UserRef::iso($c->closed_at),
            'closed_by' => self::userRef($c->closed_by, $users),
            'customer' => self::panel($c, $order, $permissions),
            'can' => [
                'reply' => $permissions->has(Permission::InboxManage),
                'assign' => $permissions->has(Permission::InboxManage),
                'link_order' => $permissions->has(Permission::InboxManage) && $canOrders && $c->channel !== InboxConversation::ORDER,
                'delete' => $permissions->has(Permission::InboxManage) && $permissions->has(Permission::CustomersDelete),
                'view_customer' => $permissions->has(Permission::CustomersView),
                'view_order' => $canOrders,
            ],
            'revision' => $c->revision,
        ];
    }

    /** §6.3 side panel; fields without the needed key are null / []. @return array<string, mixed> */
    private static function panel(InboxConversation $c, ?Order $order, PermissionSet $permissions): array
    {
        $customer = null;
        if ($permissions->has(Permission::CustomersView) && $c->customer_id !== null) {
            /** @var Customer|null $row */
            $row = Customer::query()->whereKey($c->customer_id)->first();
            if ($row !== null) {
                $customer = [
                    'id' => $row->id,
                    'name' => (string) $row->name,
                    'since' => UserRef::iso($row->created_at),
                    'orders_count' => (int) $row->orders_count,
                    'phone' => InboxText::localPhone($row->phone),
                    'email' => $row->email,
                    'address' => ['district' => $row->district ?? null, 'thana' => $row->area ?? null, 'street' => null],
                    'risk' => RiskTier::payload($row),
                ];
            }
        }
        $linked = null;
        $past = [];
        if ($permissions->has(Permission::OrdersView)) {
            if ($order !== null) {
                $linked = self::orderCard($order);
            }
            if ($c->customer_id !== null || $c->contact_phone !== null) {
                $past = Order::query()->where('store_id', $c->store_id)
                    ->where(fn ($q) => $c->customer_id !== null ? $q->where('customer_id', $c->customer_id) : $q->where('customer_phone', $c->contact_phone))
                    ->when($order !== null, fn ($q) => $q->whereKeyNot($order->id))
                    ->orderByDesc('placed_at')->orderByDesc('id')->limit(5)->get()
                    ->map(fn (Order $o) => [
                        'id' => $o->id, 'number' => $o->number, 'placed_at' => UserRef::iso($o->placed_at),
                        'total_amount' => (int) $o->total_amount, 'currency' => $o->currency, 'status' => $o->status,
                    ])->values()->all();
            }
        }

        return ['contact' => self::contact($c), 'customer' => $customer, 'linked_order' => $linked, 'past_orders' => $past];
    }

    /** @return array<string, mixed> InboxOrderCard */
    private static function orderCard(Order $order): array
    {
        $items = OrderItem::query()->where('order_id', $order->id)->orderBy('id')->get();
        /** @var OrderItem|null $first */
        $first = $items->first();
        $media = $first?->image_media_id !== null ? (MediaMaps::load([$first->image_media_id])[$first->image_media_id] ?? null) : null;

        return [
            'id' => $order->id,
            'number' => $order->number,
            'placed_at' => UserRef::iso($order->placed_at),
            'status' => $order->status,
            'payment_status' => $order->payment_status,
            'payment_method' => $order->payment_method,
            'first_line' => $first === null ? null : [
                'name' => $first->product_name,
                'variant' => $first->variant_title !== '' ? $first->variant_title : null,
                'quantity' => (int) $first->quantity,
                'image_url' => $media !== null && $media->status !== Media::FAILED ? (MediaMaps::storefrontMedia($media)['url'] ?? null) : null,
            ],
            'extra_lines' => max(0, $items->count() - 1),
            'paid_amount' => (int) $order->paid_amount,
            'due_amount' => $order->dueAmount(),
            'total_amount' => (int) $order->total_amount,
            'currency' => $order->currency,
        ];
    }

    /**
     * @param  Collection<int, InboxMessage>  $messages
     * @return list<array<string, mixed>> InboxMessage[]
     */
    public static function messages(Collection $messages, InboxConversation $c): array
    {
        $users = self::users($messages->pluck('author_user_id'));
        $assignees = self::users($messages->map(fn (InboxMessage $m) => $m->system_meta['assignee']['id'] ?? null));
        $attachments = self::attachmentsFor($messages->pluck('id')->all());

        return $messages->map(fn (InboxMessage $m) => self::message($m, $c, $users + $assignees, $attachments[$m->id] ?? []))->values()->all();
    }

    /**
     * @param  array<string, User>  $users
     * @param  list<array<string, mixed>>  $attachments
     * @return array<string, mixed>
     */
    public static function message(InboxMessage $m, InboxConversation $c, array $users, array $attachments): array
    {
        $system = $m->kind === InboxMessage::SYSTEM;
        $assignee = $m->system_meta['assignee'] ?? null;

        return [
            'id' => $m->id,
            'kind' => $m->kind,
            'body' => $system ? null : (string) $m->body,
            'author' => in_array($m->kind, [InboxMessage::REPLY, InboxMessage::NOTE], true) ? self::userRef($m->author_user_id, $users) : null,
            'attachments' => $system ? [] : $attachments,
            'system' => $system ? [
                'event' => $m->system_event,
                'actor' => self::userRef($m->author_user_id, $users),
                'assignee' => is_array($assignee) && isset($assignee['id']) ? (self::userRef((string) $assignee['id'], $users) ?? ['id' => (string) $assignee['id'], 'name' => (string) ($assignee['name'] ?? '')]) : null,
                'order_number' => isset($m->system_meta['order_number']) ? (string) $m->system_meta['order_number'] : null,
            ] : null,
            'delivery_status' => $m->delivery_status,
            'sms_status' => $m->sms_status,
            'seen' => $m->kind === InboxMessage::REPLY && $c->customer_seen_at !== null && $m->created_at->lte($c->customer_seen_at),
            'created_at' => UserRef::iso($m->created_at),
        ];
    }

    /**
     * §9.2 InboxShopperMessage: customer + reply rows only; the shop name as author; attachments as proxied ids.
     *
     * @param  Collection<int, InboxMessage>  $messages
     * @return list<array<string, mixed>>
     */
    public static function shopperMessages(Collection $messages, InboxConversation $c, string $shopName): array
    {
        $messages = $messages->filter(fn (InboxMessage $m) => in_array($m->kind, InboxMessage::SHOPPER_KINDS, true))->values();
        $attachments = self::attachmentsFor($messages->pluck('id')->all());
        $shopReadUpTo = self::shopReadUpTo($c);

        return $messages->map(fn (InboxMessage $m) => self::shopperMessage($m, $c, $shopName, $attachments[$m->id] ?? [], shopReadUpTo: $shopReadUpTo))->all();
    }

    /** Furthest message any member has read in the conversation (customer rows up to it show "Seen" to the shopper). */
    public static function shopReadUpTo(?InboxConversation $c): ?string
    {
        if ($c === null) {
            return null;
        }
        $max = InboxRead::query()->where('conversation_id', $c->id)->max('last_read_message_id');

        return is_string($max) ? $max : null;
    }

    /**
     * `seen`: shop rows — the shopper saw it (`created_at <= customer_seen_at`); customer rows — a member has read up to it
     * (Figma 2126:10642 "Seen" under the shopper's bubble; QA 8.8e SF/API-2).
     *
     * @param  list<array<string, mixed>>  $attachments
     * @return array<string, mixed>
     */
    public static function shopperMessage(InboxMessage $m, ?InboxConversation $c, string $shopName, array $attachments, ?string $customerName = null, ?string $shopReadUpTo = null): array
    {
        $shop = $m->kind === InboxMessage::REPLY;

        return [
            'id' => $m->id,
            'from' => $shop ? 'shop' : 'customer',
            'body' => $m->body,
            'attachments' => $attachments,
            'author_name' => $shop ? $shopName : ($customerName ?? $c?->contact_name ?? ''),
            'seen' => $shop
                ? $c?->customer_seen_at !== null && $m->created_at->lte($c->customer_seen_at)
                : $shopReadUpTo !== null && strcmp($m->id, $shopReadUpTo) <= 0,
            'created_at' => UserRef::iso($m->created_at),
        ];
    }

    /** @return array<string, mixed> InboxSavedReply */
    public static function savedReply(InboxSavedReply $r, ?InboxAttachment $attachment = null, ?User $updatedBy = null): array
    {
        return [
            'id' => $r->id,
            'title' => $r->title,
            'shortcut' => $r->shortcut,
            'body' => $r->body,
            'show_as_chip' => (bool) $r->show_as_chip,
            'position' => (int) $r->position,
            'attachment' => $attachment !== null ? self::attachment($attachment) : null,
            'use_count' => (int) $r->use_count,
            'last_used_at' => UserRef::iso($r->last_used_at),
            'updated_by' => UserRef::of($updatedBy),
            'updated_at' => UserRef::iso($r->updated_at),
            'revision' => (int) $r->revision,
        ];
    }

    /** @return array<string, mixed> InboxSettings */
    public static function settings(?InboxSetting $s, Store $store, bool $canEdit): array
    {
        $webChat = (bool) $s?->web_chat_enabled;
        $email = (bool) $s?->email_enabled;
        $available = InboxSettingsService::emailAvailable();
        $host = $store->relationLoaded('primaryDomain') ? $store->primaryDomain?->hostname : $store->primaryDomain()->value('hostname');

        return [
            'channels' => [
                'web_chat' => ['enabled' => $webChat, 'live_on' => $webChat ? $host : null],
                'order_messages' => ['enabled' => (bool) $s?->order_messages_enabled],
                'email' => [
                    'enabled' => $email && $available,
                    'address' => $available && $s?->email_key !== null ? ReplyAddress::store($s->email_key) : null,
                    'available' => $available,
                ],
            ],
            'widget' => [
                'reply_time' => $s->widget_reply_time ?? 'minutes',
                'hours' => $s?->widget_hours,
                'greeting' => $s?->widget_greeting,
            ],
            'external_channels' => array_map(fn (string $ch) => ['channel' => $ch, 'status' => 'coming_later'], ['messenger', 'whatsapp', 'instagram']),
            'revision' => $s->revision ?? 1,
            'can' => ['edit' => $canEdit],
        ];
    }

    /** §9.1 product card of the first web-chat message from a PDP. @return array<string, mixed>|null */
    public static function productContext(string $storeId, ?string $slug): ?array
    {
        if ($slug === null || $slug === '' || preg_match('/^[a-z0-9-]{1,220}$/', $slug) !== 1) {
            return null;
        }
        /** @var Product|null $product */
        $product = Product::query()->where('store_id', $storeId)->where('slug', $slug)->where('status', Product::ACTIVE)->first();
        if ($product === null) {
            return null;
        }
        $imageId = $product->images()->orderBy('position')->value('media_id');
        $media = $imageId !== null ? (MediaMaps::load([$imageId])[$imageId] ?? null) : null;

        return [
            'product_id' => $product->id,
            'name' => mb_substr($product->name, 0, 200),
            'price_amount' => (int) $product->price_min_amount,
            'currency' => $product->currency,
            'path' => '/products/'.$product->slug,
            'image_url' => $media !== null && $media->status !== Media::FAILED ? (MediaMaps::storefrontMedia($media)['url'] ?? null) : null,
        ];
    }
}
