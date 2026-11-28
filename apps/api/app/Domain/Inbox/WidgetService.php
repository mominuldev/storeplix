<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMagicLink;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxWidgetSession;
use App\Domain\Inbox\Support\InboxSecrets;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Inbox\Support\ThreadKey;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;

/**
 * Website chat for shoppers (PHASE-8-8E §9, P88E-10/11/13/14, S237/S238): sessions (opaque 256-bit token, sha256 at
 * rest), the 6-digit code (HMAC with INBOX_CODE_SECRET ∥ session id, 10 minutes, 5 attempts, resend after 60 s, 5 sends
 * per phone and 20 per IP per hour and store), the held first message, the unverified fallback, and the magic links of
 * the reply SMS. Inside the tenant context of the storefront host.
 */
final class WidgetService
{
    public const PENDING_HOURS = 24;

    public const VERIFIED_DAYS = 90;

    public const LINK_DAYS = 7;

    public function __construct(
        private readonly ConversationService $conversations,
        private readonly InboxAttachments $attachments,
        private readonly InboxSms $sms,
        private readonly TenantContext $context,
    ) {}

    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '='); // 43 characters
    }

    public static function codeHash(string $sessionId, string $code): string
    {
        return hash_hmac('sha256', strtolower($sessionId).'|'.$code, InboxSecrets::code());
    }

    /** The live session of this store behind `X-Inbox-Session`, else 404 `inbox_session_invalid`. */
    public function session(Store $store, ?string $token, bool $touch = true): InboxWidgetSession
    {
        $session = ($token === null || strlen($token) !== 43) ? null
            : InboxWidgetSession::query()->where('store_id', $store->id)->where('token_hash', hash('sha256', $token))->where('expires_at', '>', now())->first();
        if ($session === null) {
            throw new ApiException(404, 'inbox_session_invalid', 'This chat has ended. Start a new one.');
        }
        if ($touch && $session->last_seen_at->lt(now()->subMinute())) {
            $expires = $session->status === InboxWidgetSession::PENDING ? $session->expires_at : now()->addDays(self::VERIFIED_DAYS);
            InboxWidgetSession::query()->whereKey($session->id)->update(['last_seen_at' => now(), 'expires_at' => $expires]);
        }

        return $session;
    }

    /**
     * POST /storefront/inbox/sessions: the session with the held message, then the code SMS. When the SMS can't be
     * paid or sent the message is delivered as an UNVERIFIED conversation (P88E-14).
     *
     * @param  array{name: string, phone: string, message: string, client_id: string, context: array<string, mixed>|null, source_path: string|null}  $input
     * @return array{session_token: string, status: string, phone_masked: string, resend_after: int|null}
     */
    public function start(Store $store, array $input, ?InboxAttachment $file, string $ipKey): array
    {
        $this->assertPhoneCap($store, (string) $input['phone']);
        $token = self::newToken();
        $session = new InboxWidgetSession;
        $session->forceFill([
            'store_id' => $store->id,
            'token_hash' => hash('sha256', $token),
            'name' => $input['name'],
            'phone' => $input['phone'],
            'status' => InboxWidgetSession::PENDING,
            'pending_message' => [
                'body' => $input['message'],
                'attachment_ids' => $file !== null ? [$file->id] : [],
                'context' => $input['context'],
                'source_path' => $input['source_path'],
                'client_id' => $input['client_id'],
            ],
            'ip_hash' => hash('sha256', $ipKey),
            'last_seen_at' => now(),
            'expires_at' => now()->addHours(self::PENDING_HOURS),
        ])->save();
        if ($file !== null) {
            InboxAttachment::query()->whereKey($file->id)->update(['widget_session_id' => $session->id]);
        }

        if ($this->issueCode($store, $session)) {
            return ['session_token' => $token, 'status' => 'code_sent', 'phone_masked' => InboxText::maskPhone($session->phone),
                'resend_after' => (int) config('inbox.code_resend_seconds', 60)];
        }
        DB::transaction(fn () => $this->deliverPending($store, InboxWidgetSession::query()->whereKey($session->id)->lockForUpdate()->firstOrFail(), false));

        return ['session_token' => $token, 'status' => 'unverified', 'phone_masked' => InboxText::maskPhone($session->phone), 'resend_after' => null];
    }

    /** @return array{status: string, unread_count: int} */
    public function verify(Store $store, InboxWidgetSession $session, string $code): array
    {
        $max = (int) config('inbox.code_attempts', 5);
        $outcome = DB::transaction(function () use ($store, $session, $code, $max) {
            /** @var InboxWidgetSession $locked */
            $locked = InboxWidgetSession::query()->whereKey($session->id)->lockForUpdate()->firstOrFail();
            if ($locked->status !== InboxWidgetSession::PENDING) {
                return ['ok', $locked];
            }
            $ttl = (int) config('inbox.code_ttl_minutes', 10);
            if ($locked->code_hash === null || $locked->code_sent_at === null || $locked->code_sent_at->lt(now()->subMinutes($ttl)) || $locked->code_attempts >= $max) {
                return ['expired', $locked];
            }
            if (! hash_equals($locked->code_hash, self::codeHash($locked->id, $code))) {
                $locked->code_attempts++;
                if ($locked->code_attempts >= $max) {
                    $locked->code_hash = null; // P88E-11: the 5th wrong code burns it; a new one is required
                }
                $locked->save();

                return ['invalid', $max - $locked->code_attempts];
            }
            $locked->forceFill(['code_hash' => null, 'verified_at' => now()])->save();
            $this->deliverPending($store, $locked, true);

            return ['ok', $locked->refresh()];
        });
        if ($outcome[0] === 'expired') {
            throw new ApiException(422, 'inbox_code_expired', 'This code has expired. Ask for a new one.', ['code' => ['This code has expired. Ask for a new one.']]);
        }
        if ($outcome[0] === 'invalid') {
            $left = (int) $outcome[1];
            $message = $left > 0 ? "That code isn't right. {$left} ".($left === 1 ? 'try' : 'tries').' left.' : 'That code is used up. Ask for a new one.';
            throw new ApiException(422, 'inbox_code_invalid', $message, ['attempts_left' => $left, 'code' => [$message]]);
        }
        $conversation = $outcome[1]->conversation_id !== null ? InboxConversation::query()->find($outcome[1]->conversation_id) : null;

        return ['status' => 'verified', 'unread_count' => InboxQuery::shopperUnread($conversation)];
    }

    /** POST /storefront/inbox/sessions/resend: 60 s cooldown (429 rate_limited + retry_after), per-phone cap. */
    public function resend(Store $store, InboxWidgetSession $session): InboxWidgetSession
    {
        if ($session->status !== InboxWidgetSession::PENDING) {
            return $session;
        }
        $cooldown = (int) config('inbox.code_resend_seconds', 60);
        if ($session->code_sent_at !== null && $session->code_sent_at->gt(now()->subSeconds($cooldown))) {
            $wait = max(1, $cooldown - (int) $session->code_sent_at->diffInSeconds(now(), true));
            throw new ApiException(429, 'rate_limited', 'Wait a moment before asking for a new code.', ['retry_after' => $wait], $wait);
        }
        if (! $this->issueCode($store, $session)) {
            // P88E-14: the code can't be sent any more → deliver the held message unverified.
            DB::transaction(fn () => $this->deliverPending($store, InboxWidgetSession::query()->whereKey($session->id)->lockForUpdate()->firstOrFail(), false));
        }

        return $session->refresh();
    }

    /** A new code (hash only at rest) and its SMS; false when it can't be sent (allowance, credits, provider, phone cap). */
    /** P88E-11: 5 code sends per phone per hour and store → 429 `rate_limited` (same for every number). */
    public function assertPhoneCap(Store $store, string $phone): void
    {
        $key = self::phoneKey($store, $phone);
        if (RateLimiter::tooManyAttempts($key, (int) config('inbox.code_sends_per_phone_per_hour', 5))) {
            $wait = RateLimiter::availableIn($key);
            throw new ApiException(429, 'rate_limited', 'Too many codes for this number. Try again later.', ['retry_after' => $wait], $wait);
        }
    }

    private static function phoneKey(Store $store, string $phone): string
    {
        return 'inbox-code-phone:'.$store->id.'|'.$phone;
    }

    private function issueCode(Store $store, InboxWidgetSession $session): bool
    {
        $this->assertPhoneCap($store, $session->phone);
        RateLimiter::hit(self::phoneKey($store, $session->phone), 3600);
        $code = str_pad((string) random_int(0, 999_999), 6, '0', STR_PAD_LEFT);
        InboxWidgetSession::query()->whereKey($session->id)->update([
            'code_hash' => self::codeHash($session->id, $code),
            'code_sent_at' => now(),
            'code_attempts' => 0,
            'code_sends' => $session->code_sends + 1,
        ]);

        return $this->sms->sendCode($store, $session->phone, $code);
    }

    /**
     * §9.4: the held message into the Inbox — verified → thread `phone:{msisdn}` (customer auto-linked), else
     * `session:{id}` (unverified, never linked or texted). Session locked by the caller (§3.1 order).
     */
    private function deliverPending(Store $store, InboxWidgetSession $session, bool $verified): void
    {
        $pending = (array) ($session->pending_message ?? []);
        $threadKey = $verified ? ThreadKey::phone($session->phone) : ThreadKey::session($session->id);
        $conversation = $this->conversations->lockOrCreate($store->id, InboxConversation::WEB_CHAT, $threadKey, [
            'identity' => $verified ? InboxConversation::VERIFIED_PHONE : InboxConversation::UNVERIFIED,
            'contact_name' => $session->name,
            'contact_phone' => $session->phone,
            'customer_id' => $verified ? ConversationService::customerFor($store->id, $session->phone, null) : null,
            'context' => $pending['context'] ?? null,
            'source_path' => $pending['source_path'] ?? null,
        ]);
        if ($verified && $conversation->identity !== InboxConversation::VERIFIED_PHONE) {
            $conversation->identity = InboxConversation::VERIFIED_PHONE;
        }
        if ($verified && $conversation->contact_name !== $session->name) {
            $conversation->contact_name = mb_substr($session->name, 0, 120);
        }
        if (($pending['context'] ?? null) !== null && $conversation->messages_count > 0) {
            $conversation->context = $pending['context']; // the newest product card
        }
        $files = $this->attachments->claim((array) ($pending['attachment_ids'] ?? []), $store->id, null, $session->id, 'file');
        $this->conversations->appendCustomer($conversation, (string) ($pending['body'] ?? ''), $files, $pending['client_id'] ?? null);
        $session->forceFill([
            'status' => $verified ? InboxWidgetSession::VERIFIED : InboxWidgetSession::UNVERIFIED,
            'pending_message' => null,
            'code_hash' => null,
            'conversation_id' => $conversation->id,
            'expires_at' => now()->addDays(self::VERIFIED_DAYS),
        ])->save();
    }

    /**
     * POST /storefront/inbox/messages: verified or unverified sessions only; a blocked conversation swallows the message
     * (the shopper sees it as sent).
     *
     * @return array{0: InboxMessage, 1: InboxConversation}
     */
    public function send(Store $store, InboxWidgetSession $session, string $body, ?InboxAttachment $file, string $clientId): array
    {
        if ($session->status === InboxWidgetSession::PENDING || $session->conversation_id === null) {
            throw new ApiException(409, 'inbox_session_unverified', 'Enter the code we sent first.');
        }

        return DB::transaction(function () use ($store, $session, $body, $file, $clientId) {
            $conversation = InboxConversation::query()->whereKey($session->conversation_id)->lockForUpdate()->first()
                ?? throw new ApiException(404, 'inbox_session_invalid', 'This chat has ended. Start a new one.');
            $files = $file === null ? new Collection : $this->attachments->claim([$file->id], $store->id, null, $session->id, 'file');

            return [$this->conversations->appendCustomer($conversation, $body, $files, $clientId) ?? self::swallowed($conversation, $body), $conversation];
        });
    }

    /** A message dropped by a block, shown back to the shopper as if sent (never stored). */
    public static function swallowed(InboxConversation $conversation, string $body): InboxMessage
    {
        $message = new InboxMessage;
        $message->forceFill(['id' => strtolower((string) Str::ulid()), 'kind' => InboxMessage::CUSTOMER, 'body' => $body,
            'conversation_id' => $conversation->id, 'created_at' => now()]);

        return $message;
    }

    /** POST …/messages/seen (§9.2): customer_seen_at, pending reply SMS become `seen`. */
    public function seen(InboxConversation $conversation): void
    {
        DB::transaction(function () use ($conversation) {
            $locked = InboxConversation::query()->whereKey($conversation->id)->lockForUpdate()->firstOrFail();
            $locked->forceFill(['customer_seen_at' => now()])->save();
            InboxMessage::query()->where('conversation_id', $locked->id)->where('kind', InboxMessage::REPLY)
                ->where('sms_status', 'pending')->update(['sms_status' => 'seen']);
            app(Support\InboxVersion::class)->bump($locked->store_id);
        });
    }

    /** A magic link for the reply SMS (P88E-12): 22 base62 characters (≈ 128 bits), sha256 at rest, 7 days. */
    public function magicLink(InboxConversation $conversation): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $code = '';
        for ($i = 0; $i < 22; $i++) {
            $code .= $alphabet[random_int(0, 61)];
        }
        $link = new InboxMagicLink;
        $link->forceFill([
            'store_id' => $conversation->store_id,
            'conversation_id' => $conversation->id,
            'code_hash' => hash('sha256', $code),
            'uses' => 0,
            'expires_at' => now()->addDays(self::LINK_DAYS),
        ])->save();

        return $code;
    }

    /**
     * POST /storefront/inbox/links/{code} (§9.2): web chat → a fresh verified session on the conversation; order →
     * an order access token (7 days). Unknown / expired / used up → 404 `inbox_link_invalid`.
     *
     * @return array<string, string>
     */
    public function redeem(Store $store, string $code): array
    {
        $invalid = new ApiException(404, 'inbox_link_invalid', 'This link has expired. Open the chat on the shop’s website.');
        if (preg_match('/^[A-Za-z0-9]{22}$/', $code) !== 1) {
            throw $invalid;
        }

        return DB::transaction(function () use ($store, $code, $invalid) {
            $link = InboxMagicLink::query()->where('store_id', $store->id)->where('code_hash', hash('sha256', $code))->lockForUpdate()->first();
            $conversation = $link === null ? null : InboxConversation::query()->find($link->conversation_id);
            if ($link === null || $conversation === null || $link->expires_at->lte(now()) || $link->uses >= InboxMagicLink::MAX_USES || $conversation->isBlocked()) {
                throw $invalid;
            }
            $link->uses++;
            $link->save();
            if ($conversation->channel === InboxConversation::ORDER && $conversation->order_id !== null) {
                $order = Order::query()->whereKey($conversation->order_id)->first() ?? throw $invalid;

                return ['kind' => 'order', 'access_token' => OrderAccessToken::issue($this->context->requireId(), $store->id, $order->id, OrderAccessToken::LINK_SECONDS), 'number' => $order->number];
            }
            if ($conversation->channel !== InboxConversation::WEB_CHAT) {
                throw $invalid;
            }
            $token = self::newToken();
            $session = new InboxWidgetSession;
            $session->forceFill([
                'store_id' => $store->id,
                'token_hash' => hash('sha256', $token),
                'name' => mb_substr($conversation->contact_name, 0, 80),
                'phone' => (string) $conversation->contact_phone,
                'status' => $conversation->identity === InboxConversation::VERIFIED_PHONE ? InboxWidgetSession::VERIFIED : InboxWidgetSession::UNVERIFIED,
                'verified_at' => now(),
                'conversation_id' => $conversation->id,
                'ip_hash' => hash('sha256', 'magic-link'),
                'last_seen_at' => now(),
                'expires_at' => now()->addDays(self::VERIFIED_DAYS),
            ])->save();

            return ['kind' => 'chat', 'session_token' => $token];
        });
    }
}
