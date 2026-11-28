<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\InboxPresenter;
use App\Domain\Inbox\InboxQuery;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Models\InboxWidgetSession;
use App\Domain\Inbox\OrderMessages;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\WidgetService;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response as BaseResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Website chat for shoppers (PHASE-8-8E §9.2; server-to-server: `storefront` middleware validates X-Storefront-Host +
 * key and sets the tenant). Draft stores → 409 `store_not_live`; channel off → 404 `inbox_unavailable`. A shopper only
 * ever sees their own conversation's customer / reply rows and attachments (S236, S237). All answers `no-store`.
 */
class StorefrontInboxController
{
    public const SESSION_HEADER = 'X-Inbox-Session';

    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly WidgetService $widget,
        private readonly InboxAttachments $attachments,
        private readonly InboxVersion $version,
    ) {}

    /** The live store with website chat on. */
    public static function chatStore(Request $request): StorefrontContext
    {
        $ctx = self::liveStore($request);
        if (! (bool) InboxSetting::query()->where('store_id', $ctx->store->id)->value('web_chat_enabled')) {
            throw new ApiException(404, 'inbox_unavailable', 'Chat is not available for this shop.');
        }

        return $ctx;
    }

    public static function liveStore(Request $request): StorefrontContext
    {
        $ctx = StorefrontContext::from($request);
        if (! $ctx->isLive()) {
            throw new ApiException(409, 'store_not_live', "This shop isn't live yet.");
        }

        return $ctx;
    }

    public function session(Request $request): JsonResponse
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER));

        return new JsonResponse(['data' => $this->sessionShape($session)], 200, self::NO_STORE);
    }

    public function start(Request $request): JsonResponse
    {
        $ctx = self::chatStore($request);
        if (trim((string) $request->input('website', '')) !== '') {
            // P88E-13 honeypot: looks like success, nothing stored, nothing sent.
            return new JsonResponse(['data' => ['session_token' => WidgetService::newToken(), 'status' => 'code_sent',
                'phone_masked' => InboxText::maskPhone(Phone::bdMsisdn((string) $request->input('phone')) ?? ''), 'resend_after' => 60]], 202, self::NO_STORE);
        }
        $input = $request->validate([
            'name' => ['required', 'string', 'max:80'],
            'phone' => ['required', 'string', 'max:20', PhoneRule::bdMobile()],
            'message' => ['required', 'string', 'max:2000'],
            'client_id' => ['required', 'string', 'max:36'],
            'file' => ['sometimes', 'nullable', 'file'],
            'product_slug' => ['sometimes', 'nullable', 'string', 'max:220'],
            'page_path' => ['sometimes', 'nullable', 'string', 'max:300'],
        ]);
        $name = InboxText::line($input['name'], 80);
        $message = InboxText::clean($input['message']);
        if ($name === '' || $message === '') {
            throw ValidationException::withMessages(array_filter(['name' => $name === '' ? ['Enter your name.'] : null, 'message' => $message === '' ? ['Write a message.'] : null]));
        }
        $file = $this->upload($request, $ctx->store);

        $result = $this->widget->start($ctx->store, [
            'name' => $name,
            'phone' => (string) Phone::bdMsisdn($input['phone']),
            'message' => $message,
            'client_id' => mb_substr($input['client_id'], 0, 36),
            'context' => InboxPresenter::productContext($ctx->store->id, $input['product_slug'] ?? null),
            'source_path' => self::path($input['page_path'] ?? null),
        ], $file, StorefrontContext::ipKey($ctx->clientIp));

        return new JsonResponse(['data' => $result], 201, self::NO_STORE);
    }

    public function verify(Request $request): JsonResponse
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER));
        $input = $request->validate(['code' => ['required', 'string', 'regex:/^\d{6}$/']]);

        return new JsonResponse(['data' => $this->widget->verify($ctx->store, $session, $input['code'])], 200, self::NO_STORE);
    }

    public function resend(Request $request): JsonResponse
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->resend($ctx->store, $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER)));

        return new JsonResponse(['data' => $this->sessionShape($session)], 200, self::NO_STORE);
    }

    public function messages(Request $request): BaseResponse
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER));
        $after = self::after($request);
        $etag = $this->version->etag($ctx->store->id, null, ['chat', $session->id, $session->conversation_id, $after]);
        if (($hit = InboxVersion::notModified($request, $etag)) !== null) {
            return $hit;
        }
        $conversation = $session->conversation_id !== null ? InboxConversation::query()->find($session->conversation_id) : null;

        return InboxVersion::respond(['data' => self::thread($conversation, $after, $ctx->store)], $etag);
    }

    public function send(Request $request): JsonResponse
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER));
        [$body, $clientId] = self::shopperInput($request);
        if ($session->status === InboxWidgetSession::PENDING) {
            throw new ApiException(409, 'inbox_session_unverified', 'Enter the code we sent first.');
        }
        $file = $this->upload($request, $ctx->store, $session->id);
        [$message, $conversation] = $this->widget->send($ctx->store, $session, $body, $file, $clientId);

        return new JsonResponse(['data' => self::shopperShape($message, $conversation, $ctx->store)], 201, self::NO_STORE);
    }

    public function seen(Request $request): Response
    {
        $ctx = self::chatStore($request);
        $session = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER));
        $conversation = $session->conversation_id !== null ? InboxConversation::query()->find($session->conversation_id) : null;
        if ($conversation !== null) {
            $this->widget->seen($conversation);
        }

        return new Response('', 204, self::NO_STORE);
    }

    /** GET /storefront/inbox/attachments/{id}: X-Inbox-Session (chat) or X-Order-Access (order page). */
    public function attachment(Request $request, string $attachment, TenantStorage $storage, OrderMessages $orders): StreamedResponse
    {
        if ($request->hasHeader('X-Order-Access')) {
            $ctx = StorefrontOrderMessagesController::orderStore($request);
            $conversationId = $orders->conversation($orders->order($ctx->store, $request->header('X-Order-Access')))?->id;
        } else {
            $ctx = self::chatStore($request);
            $conversationId = $this->widget->session($ctx->store, $request->header(self::SESSION_HEADER))->conversation_id;
        }
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $attachment) === 1
            ? InboxAttachment::query()->where('store_id', $ctx->store->id)->whereKey(strtolower($attachment))->first() : null;
        if ($conversationId === null || ! InboxAttachmentController::shopperVisible($row, $conversationId)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return InboxAttachmentController::stream($row, $storage);
    }

    public function link(Request $request, string $code): JsonResponse
    {
        $ctx = self::liveStore($request);

        return new JsonResponse(['data' => $this->widget->redeem($ctx->store, $code)], 200, self::NO_STORE);
    }

    // ---- shared with the order Messages ----

    /** @return list<array<string, mixed>> */
    public static function thread(?InboxConversation $conversation, ?string $after, Store $store): array
    {
        if ($conversation === null) {
            return [];
        }
        $query = InboxMessage::query()->where('conversation_id', $conversation->id)->whereIn('kind', InboxMessage::SHOPPER_KINDS);
        $messages = $after !== null
            ? $query->where('id', '>', $after)->orderBy('id')->limit(100)->get()
            : $query->orderByDesc('id')->limit(50)->get()->reverse()->values();

        return InboxPresenter::shopperMessages($messages, $conversation, $store->name);
    }

    /** @return array<string, mixed> */
    public static function shopperShape(InboxMessage $message, InboxConversation $conversation, Store $store): array
    {
        $files = $message->exists ? (InboxPresenter::attachmentsFor([$message->id])[$message->id] ?? []) : [];

        return InboxPresenter::shopperMessage($message, $conversation, $store->name, $files);
    }

    /** @return array{0: string, 1: string} */
    public static function shopperInput(Request $request): array
    {
        $input = $request->validate([
            'body' => ['present', 'nullable', 'string', 'max:2000'],
            'client_id' => ['required', 'string', 'max:36'],
            'file' => ['sometimes', 'nullable', 'file'],
        ]);
        $body = InboxText::clean($input['body'] ?? '');
        if ($body === '' && ! $request->hasFile('file')) {
            throw ValidationException::withMessages(['body' => ['Write a message.']]);
        }

        return [$body, $input['client_id']];
    }

    /** An optional shopper file (≤ 1 per message from the storefront), sniffed like every Inbox upload. */
    public function upload(Request $request, Store $store, ?string $sessionId = null): ?InboxAttachment
    {
        $file = $request->file('file');
        if (! $file instanceof UploadedFile) {
            return null;
        }
        $info = $this->attachments->inspect($file);
        if (is_string($info)) {
            throw ValidationException::withMessages(['file' => [$info]]);
        }

        return $this->attachments->store($file, $info, $store, InboxAttachment::BY_SHOPPER, null, $sessionId);
    }

    public static function after(Request $request): ?string
    {
        $after = $request->query('after');

        return is_string($after) && preg_match('/^[0-9A-Za-z]{26}$/', $after) === 1 ? strtolower($after) : null;
    }

    /** A storefront path only (no scheme, host or query), ≤ 300. */
    private static function path(?string $path): ?string
    {
        $path = (string) parse_url((string) $path, PHP_URL_PATH);
        $path = InboxText::line($path, 300);

        return str_starts_with($path, '/') && ! str_starts_with($path, '//') ? $path : null;
    }

    /** @return array<string, mixed> InboxWidgetSession */
    private function sessionShape(InboxWidgetSession $session): array
    {
        $conversation = $session->conversation_id !== null ? InboxConversation::query()->find($session->conversation_id) : null;
        $cooldown = (int) config('inbox.code_resend_seconds', 60);
        $resend = null;
        if ($session->status === InboxWidgetSession::PENDING) {
            $resend = $session->code_sent_at === null ? 0 : max(0, $cooldown - (int) $session->code_sent_at->diffInSeconds(now(), true));
        }

        return [
            'status' => $session->status,
            'name' => $session->name,
            'phone_masked' => InboxText::maskPhone($session->phone),
            'unread_count' => InboxQuery::shopperUnread($conversation),
            'resend_after' => $resend,
        ];
    }
}
