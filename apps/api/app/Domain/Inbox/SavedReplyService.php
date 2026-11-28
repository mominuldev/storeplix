<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Identity\Models\User;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxSavedReply;
use App\Domain\Orders\Models\Order;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Saved replies (PHASE-8-8E §8, P88E-8): team-shared per store, ≤ 200, shortcut unique per store case-insensitively,
 * merge tags checked on save and rendered per conversation; an optional attachment that is COPIED into each reply.
 * Audited `inbox_saved_reply.created|updated|deleted`.
 */
final class SavedReplyService
{
    public const TAGS = ['customer_name', 'shop_name', 'order_number', 'order_total', 'order_due', 'delivery_inside', 'delivery_outside', 'payment_link', 'track_url'];

    public function __construct(
        private readonly InboxAttachments $attachments,
        private readonly AuditLogger $audit,
    ) {}

    /** @return list<string> `{word}` tags of a body that are not merge tags */
    public static function unknownTags(string $body): array
    {
        preg_match_all('/\{([a-z_]{1,40})\}/i', $body, $m);

        return array_values(array_unique(array_filter($m[1], fn (string $tag) => ! in_array($tag, self::TAGS, true))));
    }

    /** @param array<string, mixed> $input validated */
    public function create(Store $store, User $user, array $input): InboxSavedReply
    {
        self::assertTags((string) $input['body']);

        return $this->guardShortcut(fn () => DB::transaction(function () use ($store, $user, $input) {
            // Serialise creates per store (limit + position) on the store row.
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $count = InboxSavedReply::query()->where('store_id', $store->id)->count();
            if ($count >= InboxSavedReply::MAX) {
                throw new ApiException(422, 'saved_reply_limit_reached', 'You can keep up to 200 saved replies. Delete one to add another.');
            }
            $this->assertShortcutFree($store->id, (string) $input['shortcut'], null);
            $reply = new InboxSavedReply;
            $reply->forceFill([
                'store_id' => $store->id,
                'title' => $input['title'],
                'shortcut' => strtolower((string) $input['shortcut']),
                'body' => $input['body'],
                'show_as_chip' => (bool) ($input['show_as_chip'] ?? false),
                'position' => (int) InboxSavedReply::query()->where('store_id', $store->id)->max('position') + 1,
                'created_by' => $user->id,
                'updated_by' => $user->id,
                'revision' => 1,
            ])->save();
            if (($input['attachment_id'] ?? null) !== null) {
                $file = $this->attachments->claim([(string) $input['attachment_id']], $store->id, $user->id, null, 'attachment_id')->first();
                InboxAttachment::query()->whereKey($file->id)->update(['saved_reply_id' => $reply->id]);
            }
            $this->audit->log('inbox_saved_reply.created', null, ['saved_reply_id' => $reply->id, 'shortcut' => $reply->shortcut]);

            return $reply;
        }));
    }

    /** @param array<string, mixed> $input validated */
    public function update(Store $store, string $id, User $user, array $input): InboxSavedReply
    {
        if (array_key_exists('body', $input)) {
            self::assertTags((string) $input['body']);
        }

        return $this->guardShortcut(fn () => DB::transaction(function () use ($store, $id, $user, $input) {
            $reply = InboxSavedReply::query()->where('store_id', $store->id)->whereKey(strtolower($id))->lockForUpdate()->first()
                ?? throw new ApiException(404, 'not_found', 'Resource not found.');
            if ((int) $input['revision'] !== $reply->revision) {
                throw new ApiException(409, 'revision_conflict', 'This saved reply changed meanwhile. Reload and try again.');
            }
            if (array_key_exists('shortcut', $input)) {
                $this->assertShortcutFree($store->id, (string) $input['shortcut'], $reply->id);
                $reply->shortcut = strtolower((string) $input['shortcut']);
            }
            foreach (['title', 'body'] as $key) {
                if (array_key_exists($key, $input)) {
                    $reply->{$key} = $input[$key];
                }
            }
            if (array_key_exists('show_as_chip', $input)) {
                $reply->show_as_chip = (bool) $input['show_as_chip'];
            }
            $changed = array_keys($reply->getDirty());
            if (array_key_exists('attachment_id', $input)) {
                $current = InboxAttachment::query()->where('saved_reply_id', $reply->id)->first();
                $next = $input['attachment_id'] === null ? null : strtolower((string) $input['attachment_id']);
                if ($current?->id !== $next) {
                    if ($current !== null) {
                        $this->attachments->remove([$current]);
                    }
                    if ($next !== null) {
                        $file = $this->attachments->claim([$next], $store->id, $user->id, null, 'attachment_id')->first();
                        InboxAttachment::query()->whereKey($file->id)->update(['saved_reply_id' => $reply->id]);
                    }
                    $changed[] = 'attachment';
                }
            }
            $reply->revision++;
            $reply->updated_by = $user->id;
            $reply->save();
            $this->audit->log('inbox_saved_reply.updated', null, ['saved_reply_id' => $reply->id, 'changed' => array_values(array_diff($changed, ['updated_at']))]);

            return $reply;
        }));
    }

    public function delete(Store $store, string $id): void
    {
        DB::transaction(function () use ($store, $id) {
            $reply = InboxSavedReply::query()->where('store_id', $store->id)->whereKey(strtolower($id))->lockForUpdate()->first()
                ?? throw new ApiException(404, 'not_found', 'Resource not found.');
            $this->attachments->remove(InboxAttachment::query()->where('saved_reply_id', $reply->id)->get());
            InboxSavedReply::query()->whereKey($reply->id)->delete();
            $this->audit->log('inbox_saved_reply.deleted', null, ['saved_reply_id' => $reply->id, 'shortcut' => $reply->shortcut]);
        });
    }

    /** @param list<string> $ids every id of the store in the new order */
    public function reorder(Store $store, array $ids): void
    {
        DB::transaction(function () use ($store, $ids) {
            $ids = array_map('strtolower', $ids);
            $all = InboxSavedReply::query()->where('store_id', $store->id)->lockForUpdate()->pluck('id')->all();
            sort($all);
            $given = $ids;
            sort($given);
            if ($given !== $all || count(array_unique($ids)) !== count($ids)) {
                throw ValidationException::withMessages(['ids' => ['Send every saved reply id exactly once.']]);
            }
            foreach ($ids as $position => $id) {
                InboxSavedReply::query()->whereKey($id)->update(['position' => $position + 1]);
            }
        });
    }

    /**
     * §8.2 render for a conversation: tags with a value are filled, the rest stay as `{tag}` and are listed in
     * `unresolved`; the attachment is copied into a fresh upload of this member.
     *
     * @return array{body: string, attachment: InboxAttachment|null, unresolved: list<string>}
     */
    public function render(Store $store, InboxConversation $conversation, InboxSavedReply $reply, User $user): array
    {
        $values = self::values($store, $conversation);
        $unresolved = [];
        $body = (string) preg_replace_callback('/\{([a-z_]{1,40})\}/', function (array $m) use ($values, &$unresolved) {
            if (! in_array($m[1], self::TAGS, true)) {
                return $m[0];
            }
            $value = $values[$m[1]] ?? null;
            if ($value === null || $value === '') {
                $unresolved[] = $m[1];

                return $m[0];
            }

            return $value;
        }, $reply->body);
        $source = InboxAttachment::query()->where('saved_reply_id', $reply->id)->first();
        $copy = $source !== null ? DB::transaction(fn () => $this->attachments->copy($source, $user->id)) : null;

        return ['body' => $body, 'attachment' => $copy, 'unresolved' => array_values(array_unique($unresolved))];
    }

    /** @return array<string, string|null> */
    public static function values(Store $store, InboxConversation $conversation): array
    {
        $order = $conversation->order_id !== null ? Order::query()->whereKey($conversation->order_id)->first() : null;
        $zones = ShippingZone::query()->where('store_id', $store->id)->where('is_active', true)->orderBy('position')->get();
        $inside = $zones->first(fn (ShippingZone $z) => ! $z->isFallback() && str_contains(strtolower($z->name), 'inside dhaka'))
            ?? $zones->first(fn (ShippingZone $z) => ! $z->isFallback());
        $outside = $zones->first(fn (ShippingZone $z) => $z->isFallback());
        $host = $store->primaryDomain()->value('hostname');
        $link = null;
        if ($order !== null) {
            $link = PaymentLink::query()->where('order_id', $order->id)->orderByDesc('created_at')->orderByDesc('id')->get()
                ->first(fn (PaymentLink $l) => PaymentPresenter::linkStatus($l) === PaymentLink::ACTIVE);
        }
        $first = trim(explode(' ', trim($conversation->contact_name))[0] ?? '');

        return [
            'customer_name' => $first !== '' ? $first : null,
            'shop_name' => $store->name,
            'order_number' => $order?->number,
            'order_total' => $order !== null ? self::taka((int) $order->total_amount) : null,
            'order_due' => $order !== null ? self::taka($order->dueAmount()) : null,
            'delivery_inside' => $inside !== null ? self::taka((int) $inside->charge_amount) : null,
            'delivery_outside' => $outside !== null ? self::taka((int) $outside->charge_amount) : null,
            'payment_link' => $link !== null ? PaymentUrls::linkUrl($store, PaymentPresenter::linkToken($link)) : null,
            'track_url' => $host ? "https://{$host}/track" : null,
        ];
    }

    /** `৳1,920` (§8.2). */
    public static function taka(int $paisa): string
    {
        return '৳'.Money::plain($paisa);
    }

    private static function assertTags(string $body): void
    {
        $unknown = self::unknownTags($body);
        if ($unknown !== []) {
            throw new ApiException(422, 'saved_reply_unknown_merge_tag', 'Unknown merge tag: {'.implode('}, {', $unknown).'}.', ['tags' => $unknown]);
        }
    }

    private function assertShortcutFree(string $storeId, string $shortcut, ?string $exceptId): void
    {
        $taken = InboxSavedReply::query()->where('store_id', $storeId)->whereRaw('lower(shortcut) = ?', [strtolower($shortcut)])
            ->when($exceptId !== null, fn ($q) => $q->whereKeyNot($exceptId))->exists();
        if ($taken) {
            throw self::shortcutTaken();
        }
    }

    /**
     * @template T
     *
     * @param  callable(): T  $fn
     * @return T
     */
    private function guardShortcut(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (UniqueConstraintViolationException) {
            throw self::shortcutTaken();
        }
    }

    private static function shortcutTaken(): ApiException
    {
        return new ApiException(409, 'saved_reply_shortcut_taken', 'Another saved reply already uses this shortcut.');
    }
}
