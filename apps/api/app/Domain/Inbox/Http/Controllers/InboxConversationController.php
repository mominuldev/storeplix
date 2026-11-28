<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Identity\Models\User;
use App\Domain\Inbox\ConversationService;
use App\Domain\Inbox\Http\Requests\SendInboxMessageRequest;
use App\Domain\Inbox\InboxMembers;
use App\Domain\Inbox\InboxPresenter;
use App\Domain\Inbox\InboxQuery;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;
use Symfony\Component\HttpFoundation\Response as BaseResponse;

/**
 * Merchant Inbox (PHASE-8-8E §5, §6): summary, list, thread, messages and the conversation actions. `inbox.manage` on
 * every route (+ customers.delete on delete, + orders.view on the order link), conversations of this store only (else
 * 404). The polled GETs answer 304 on a matching If-None-Match before any Inbox query (P88E-17).
 */
class InboxConversationController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly ConversationService $conversations,
        private readonly InboxVersion $version,
        private readonly TenantContext $context,
    ) {}

    public static function find(Store $store, string $id): InboxConversation
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1
            ? InboxConversation::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    public function summary(Request $request, Store $store): BaseResponse
    {
        $user = self::user($request);
        $etag = $this->version->etag($store->id, $user->id, ['summary', $user->id]);
        if (($hit = InboxVersion::notModified($request, $etag)) !== null) {
            return $hit;
        }

        return InboxVersion::respond(['data' => InboxQuery::summary($store->id, $user->id)], $etag);
    }

    public function index(Request $request, Store $store): BaseResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', Rule::in(InboxConversation::STATUSES)],
            'filter.scope' => ['sometimes', Rule::in(['mine_unassigned', 'mine', 'unassigned', 'all'])],
            'filter.channel' => ['sometimes', 'string', 'max:40', 'regex:/^(web_chat|order|email)(,(web_chat|order|email))*$/'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);
        $user = self::user($request);
        $status = $input['filter']['status'] ?? InboxConversation::OPEN;
        $scope = $input['filter']['scope'] ?? 'mine_unassigned';
        $channels = isset($input['filter']['channel']) ? array_values(array_unique(explode(',', $input['filter']['channel']))) : [];
        $q = $input['q'] ?? null;
        $etag = $this->version->etag($store->id, $user->id, ['list', $user->id, $status, $scope, implode(',', $channels), $q, $input['cursor'] ?? '']);
        if (($hit = InboxVersion::notModified($request, $etag)) !== null) {
            return $hit;
        }

        $page = InboxQuery::filtered($store->id, $user->id, $scope, $channels, $q)->where('status', $status)
            ->orderByDesc('last_message_at')->orderByDesc('id')
            ->cursorPaginate(InboxQuery::PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);
        $rows = collect($page->items());
        $users = InboxPresenter::users($rows->pluck('assignee_id'));
        $orders = Order::query()->whereIn('id', $rows->pluck('order_id')->filter()->values()->all())->pluck('number', 'id')->all();
        $unread = InboxQuery::unreadCounts($rows->pluck('id')->all(), $user->id);
        $counts = InboxQuery::filtered($store->id, $user->id, $scope, $channels, $q)
            ->selectRaw('status, count(*) as c')->groupBy('status')->pluck('c', 'status');

        return InboxVersion::respond([
            'data' => $rows->map(fn (InboxConversation $c) => InboxPresenter::summaryRow($c, $users, $orders, $unread[$c->id] ?? 0))->values()->all(),
            'meta' => [
                'counts' => array_combine(InboxConversation::STATUSES, array_map(fn ($s) => (int) ($counts[$s] ?? 0), InboxConversation::STATUSES)),
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ], $etag);
    }

    public function show(Request $request, Store $store, string $conversation): JsonResponse
    {
        return new JsonResponse(['data' => $this->present($request, self::find($store, $conversation))], 200, self::NO_STORE);
    }

    public function messages(Request $request, Store $store, string $conversation): BaseResponse
    {
        $input = $request->validate([
            'after' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'before' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
        ]);
        $after = isset($input['after']) ? strtolower($input['after']) : null;
        $before = isset($input['before']) ? strtolower($input['before']) : null;
        $etag = $this->version->etag($store->id, null, ['messages', strtolower($conversation), $after, $before]);
        if (($hit = InboxVersion::notModified($request, $etag)) !== null) {
            return $hit;
        }
        $row = self::find($store, $conversation);
        $query = InboxMessage::query()->where('conversation_id', $row->id);
        if ($after !== null) {
            $messages = $query->where('id', '>', $after)->orderBy('id')->limit(100)->get();
        } else {
            $messages = $query->when($before !== null, fn ($q) => $q->where('id', '<', $before))->orderByDesc('id')->limit(50)->get()->reverse()->values();
        }

        return InboxVersion::respond(['data' => InboxPresenter::messages($messages, $row)], $etag);
    }

    public function send(SendInboxMessageRequest $request, Store $store, string $conversation): JsonResponse
    {
        $row = self::find($store, $conversation);
        [$message, $created] = $this->conversations->send($store, $row->id, self::user($request), $request->validated());

        return new JsonResponse(['data' => InboxPresenter::messages(collect([$message]), $row->refresh())[0]], $created ? 201 : 200, self::NO_STORE);
    }

    public function assign(Request $request, Store $store, string $conversation): JsonResponse
    {
        $input = $request->validate([
            'assignee_id' => ['present', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'revision' => ['sometimes', 'nullable', 'integer', 'min:1'],
        ]);
        $row = self::find($store, $conversation);
        $row = $this->conversations->assign($store, $row->id, self::user($request), $input['assignee_id'] ?? null, $input['revision'] ?? null);

        return new JsonResponse(['data' => $this->present($request, $row)], 200, self::NO_STORE);
    }

    public function status(Request $request, Store $store, string $conversation): JsonResponse
    {
        $input = $request->validate([
            'status' => ['required', Rule::in(InboxConversation::STATUSES)],
            'revision' => ['sometimes', 'nullable', 'integer', 'min:1'],
        ]);
        $row = self::find($store, $conversation);
        $row = $this->conversations->setStatus($row->id, self::user($request), $input['status'], $input['revision'] ?? null);

        return new JsonResponse(['data' => $this->present($request, $row)], 200, self::NO_STORE);
    }

    public function order(Request $request, Store $store, string $conversation): JsonResponse
    {
        $input = $request->validate(['order_id' => ['present', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/']]);
        $row = self::find($store, $conversation);
        $row = $this->conversations->linkOrder($store, $row->id, self::user($request), $input['order_id'] ?? null);

        return new JsonResponse(['data' => $this->present($request, $row)], 200, self::NO_STORE);
    }

    public function block(Request $request, Store $store, string $conversation): JsonResponse
    {
        $row = $this->conversations->block(self::find($store, $conversation)->id, self::user($request), true);

        return new JsonResponse(['data' => $this->present($request, $row)], 200, self::NO_STORE);
    }

    public function unblock(Request $request, Store $store, string $conversation): JsonResponse
    {
        $row = $this->conversations->block(self::find($store, $conversation)->id, self::user($request), false);

        return new JsonResponse(['data' => $this->present($request, $row)], 200, self::NO_STORE);
    }

    public function read(Request $request, Store $store, string $conversation): Response
    {
        $input = $request->validate(['last_read_message_id' => ['required', 'string', 'regex:/^[0-9A-Za-z]{26}$/']]);
        $this->conversations->markRead(self::find($store, $conversation)->id, self::user($request), $input['last_read_message_id']);

        return new Response('', 204);
    }

    public function destroy(Store $store, string $conversation): Response
    {
        $this->conversations->delete(self::find($store, $conversation)->id);

        return new Response('', 204);
    }

    public function assignees(Request $request, Store $store, InboxMembers $members): JsonResponse
    {
        $me = self::user($request)->id;
        $open = InboxConversation::query()->where('store_id', $store->id)->where('status', InboxConversation::OPEN)->whereNotNull('assignee_id')
            ->selectRaw('assignee_id, count(*) as c')->groupBy('assignee_id')->pluck('c', 'assignee_id');
        $rows = collect($members->all())
            ->sortBy(fn (array $m) => [$m['user']->id === $me ? 0 : 1, mb_strtolower((string) $m['user']->name)])
            ->map(fn (array $m) => [
                'user' => UserRef::of($m['user']),
                'role_name' => $m['role_name'],
                'open_count' => (int) ($open[$m['user']->id] ?? 0),
                'is_you' => $m['user']->id === $me,
            ])->values()->all();

        return new JsonResponse(['data' => $rows], 200, self::NO_STORE);
    }

    /** @return array<string, mixed> */
    private function present(Request $request, InboxConversation $row): array
    {
        $user = self::user($request);
        $unread = InboxQuery::unreadCounts([$row->id], $user->id)[$row->id] ?? 0;

        return InboxPresenter::conversation($row->refresh(), $this->context->permissions(), $unread);
    }

    private static function user(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }
}
