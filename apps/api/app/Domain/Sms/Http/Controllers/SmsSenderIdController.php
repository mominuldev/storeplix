<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Http\Requests\SenderIdRequest;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SenderIds\SenderIdPresenter;
use App\Domain\Sms\SenderIds\SenderIdService;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/**
 * PHASE-8-9A §8.2 `/stores/{store}/sms/sender-ids…`: list (active, pending, last 20), request (multipart, 201), cancel.
 * `{sender_id}` of another store or tenant → 404 (S208). The trade licence is never downloadable here (S216).
 */
class SmsSenderIdController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly SenderIdService $senderIds) {}

    public function index(Store $store): JsonResponse
    {
        $rows = SmsSenderId::query()->where('store_id', $store->id)->with(['document', 'requestedBy'])
            ->orderByDesc('requested_at')->orderByDesc('id')->limit(20)->get();
        $active = SmsSenderId::query()->where('store_id', $store->id)->where('status', SmsSenderId::APPROVED)->with(['document', 'requestedBy'])->first();
        $pending = SmsSenderId::query()->where('store_id', $store->id)->where('status', SmsSenderId::PENDING)->with(['document', 'requestedBy'])->first();

        return new JsonResponse(['data' => [
            'active' => $active !== null ? SenderIdPresenter::request($active) : null,
            'pending' => $pending !== null ? SenderIdPresenter::request($pending) : null,
            'history' => $rows->map(fn (SmsSenderId $r) => SenderIdPresenter::request($r))->values()->all(),
        ]], 200, self::NO_STORE);
    }

    public function store(SenderIdRequest $request, Store $store): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        $input = $request->validated();
        $row = $this->senderIds->request($store, [
            'sender_id' => (string) $input['sender_id'],
            'business_name' => (string) $input['business_name'],
            'uses' => array_values((array) $input['uses']),
            'note' => $input['note'] ?? null,
        ], $request->file('document'), (array) $request->inspected, $user);

        return new JsonResponse(['data' => SenderIdPresenter::request($row)], 201, self::NO_STORE);
    }

    public function cancel(Store $store, string $sender_id): JsonResponse
    {
        $row = SmsSenderId::query()->where('store_id', $store->id)->whereKey(strtolower($sender_id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        return new JsonResponse(['data' => SenderIdPresenter::request($this->senderIds->cancel($row))], 200, self::NO_STORE);
    }
}
