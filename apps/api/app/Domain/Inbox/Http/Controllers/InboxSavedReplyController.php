<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Identity\Models\User;
use App\Domain\Inbox\Http\Requests\SavedReplyRequest;
use App\Domain\Inbox\InboxPresenter;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxSavedReply;
use App\Domain\Inbox\SavedReplyService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Collection;

/** Saved replies (PHASE-8-8E §8): list, create, update, delete, reorder, render for a conversation. `inbox.manage`. */
class InboxSavedReplyController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly SavedReplyService $service) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'q' => ['sometimes', 'nullable', 'string', 'max:60'],
            'filter' => ['sometimes', 'array'],
            'filter.chip' => ['sometimes', 'in:1'],
            'filter.attachment' => ['sometimes', 'in:1'],
        ]);
        $all = InboxSavedReply::query()->where('store_id', $store->id)->orderBy('position')->orderBy('id')->get();
        $files = InboxAttachment::query()->whereIn('saved_reply_id', $all->pluck('id')->all())->get()->keyBy('saved_reply_id');
        $q = mb_strtolower(trim((string) ($input['q'] ?? '')));
        $rows = $all->filter(fn (InboxSavedReply $r) => ($q === '' || str_contains(mb_strtolower($r->title), $q) || str_contains($r->shortcut, ltrim($q, '/')))
            && (! isset($input['filter']['chip']) || $r->show_as_chip)
            && (! isset($input['filter']['attachment']) || isset($files[$r->id])));

        return new JsonResponse([
            'data' => $this->present($rows, $files),
            'meta' => ['counts' => [
                'all' => $all->count(),
                'chips' => $all->where('show_as_chip', true)->count(),
                'with_attachment' => $all->filter(fn (InboxSavedReply $r) => isset($files[$r->id]))->count(),
            ]],
        ], 200, self::NO_STORE);
    }

    public function store(SavedReplyRequest $request, Store $store): JsonResponse
    {
        $reply = $this->service->create($store, self::user($request), $request->validated());

        return new JsonResponse(['data' => $this->one($reply)], 201, self::NO_STORE);
    }

    public function update(SavedReplyRequest $request, Store $store, string $savedReply): JsonResponse
    {
        $reply = $this->service->update($store, self::id($savedReply), self::user($request), $request->validated());

        return new JsonResponse(['data' => $this->one($reply)], 200, self::NO_STORE);
    }

    public function destroy(Store $store, string $savedReply): Response
    {
        $this->service->delete($store, self::id($savedReply));

        return new Response('', 204);
    }

    public function reorder(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'ids' => ['present', 'array', 'max:'.InboxSavedReply::MAX],
            'ids.*' => ['string', 'regex:/^[0-9A-Za-z]{26}$/'],
        ]);
        $this->service->reorder($store, array_values($input['ids']));
        $all = InboxSavedReply::query()->where('store_id', $store->id)->orderBy('position')->orderBy('id')->get();
        $files = InboxAttachment::query()->whereIn('saved_reply_id', $all->pluck('id')->all())->get()->keyBy('saved_reply_id');

        return new JsonResponse(['data' => $this->present($all, $files)], 200, self::NO_STORE);
    }

    public function render(Request $request, Store $store, string $conversation, string $savedReply): JsonResponse
    {
        $row = InboxConversationController::find($store, $conversation);
        $reply = InboxSavedReply::query()->where('store_id', $store->id)->whereKey(self::id($savedReply))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        $out = $this->service->render($store, $row, $reply, self::user($request));

        return new JsonResponse(['data' => [
            'body' => $out['body'],
            'attachment' => $out['attachment'] !== null ? InboxPresenter::attachment($out['attachment']) : null,
            'unresolved' => $out['unresolved'],
        ]], 200, self::NO_STORE);
    }

    /** @return array<string, mixed> */
    private function one(InboxSavedReply $reply): array
    {
        $reply->refresh();

        return InboxPresenter::savedReply($reply, InboxAttachment::query()->where('saved_reply_id', $reply->id)->first(),
            $reply->updated_by !== null ? User::query()->find($reply->updated_by) : null);
    }

    /**
     * @param  Collection<int, InboxSavedReply>  $rows
     * @param  Collection<string, InboxAttachment>  $files
     * @return list<array<string, mixed>>
     */
    private function present(Collection $rows, Collection $files): array
    {
        $users = InboxPresenter::users($rows->pluck('updated_by'));

        return $rows->map(fn (InboxSavedReply $r) => InboxPresenter::savedReply($r, $files[$r->id] ?? null, $users[$r->updated_by] ?? null))->values()->all();
    }

    private static function id(string $id): string
    {
        return preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? strtolower($id) : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private static function user(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }
}
