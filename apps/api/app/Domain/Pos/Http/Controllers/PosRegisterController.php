<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Controllers;

use App\Domain\Pos\Http\Requests\ClosePosSessionRequest;
use App\Domain\Pos\Http\Requests\OpenPosSessionRequest;
use App\Domain\Pos\Http\Requests\PosPlanGate;
use App\Domain\Pos\Http\Requests\PosRegisterRequest;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Pos\PosPresenter;
use App\Domain\Pos\PosRegisterService;
use App\Domain\Pos\PosSessionService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-8D §4, §10 `/stores/{store}/pos/registers…` and `/pos/sessions…`. `{register}` / `{session}` resolve inside the
 * store and tenant: another store's or tenant's id → 404 `not_found` (S195). Register writes `settings.manage`, every
 * other route `pos.sell` (route middleware).
 */
class PosRegisterController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly PosRegisterService $registers,
        private readonly PosSessionService $sessions,
    ) {}

    /** Active registers by location (shops first), position, name; `filter[archived]=true` → archived only. */
    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array:archived'],
            'filter.archived' => ['sometimes', 'string', 'in:true,false,1,0'],
        ]);
        $archived = in_array($input['filter']['archived'] ?? 'false', ['true', '1'], true);
        $rows = PosRegister::query()->where('pos_registers.store_id', $store->id)
            ->when($archived, fn ($q) => $q->whereNotNull('pos_registers.archived_at'), fn ($q) => $q->whereNull('pos_registers.archived_at'))
            ->join('locations', 'locations.id', '=', 'pos_registers.location_id')
            ->orderByRaw("case when locations.type = 'shop' then 0 else 1 end")
            ->orderBy('locations.position')->orderBy('locations.name')
            ->orderBy('pos_registers.position')->orderBy('pos_registers.name')->orderBy('pos_registers.id')
            ->select('pos_registers.*')->with('location')->get();

        return new JsonResponse(['data' => $rows->map(fn (PosRegister $r) => PosPresenter::register($r))->values()->all()], 200, self::NO_STORE);
    }

    public function store(PosRegisterRequest $request, Store $store): JsonResponse
    {
        /** @var array{name: string, location_id: string, position?: int} $input */
        $input = $request->validated();

        return $this->register($this->registers->create($store, $input, $request->user()), 201);
    }

    public function update(PosRegisterRequest $request, Store $store, string $register): JsonResponse
    {
        /** @var array{name?: string, location_id?: string, position?: int} $input */
        $input = $request->validated();

        return $this->register($this->registers->update($store, self::findRegister($store, $register), $input));
    }

    public function archive(Store $store, string $register): JsonResponse
    {
        return $this->register($this->registers->archive($store, self::findRegister($store, $register)));
    }

    public function unarchive(Store $store, string $register): JsonResponse
    {
        $row = self::findRegister($store, $register);
        PosPlanGate::assert();

        return $this->register($this->registers->unarchive($store, $row));
    }

    public function open(OpenPosSessionRequest $request, Store $store, string $register): JsonResponse
    {
        /** @var array{counts?: array<string, int>, opening_cash_amount?: int, note?: string|null} $input */
        $input = $request->validated();
        $session = $this->sessions->open($store, self::findRegister($store, $register), $input, $request->user());

        return new JsonResponse(['data' => PosPresenter::session($session->refresh())], 201, self::NO_STORE);
    }

    public function session(Store $store, string $session): JsonResponse
    {
        return new JsonResponse(['data' => PosPresenter::session(self::findSession($store, $session))], 200, self::NO_STORE);
    }

    public function close(ClosePosSessionRequest $request, Store $store, string $session): JsonResponse
    {
        /** @var array{counts?: array<string, int>, counted_cash_amount?: int, left_in_drawer_amount: int, note?: string|null, revision: int} $input */
        $input = $request->validated();
        $row = $this->sessions->close($store, self::findSession($store, $session), $input, $request->user());

        return new JsonResponse(['data' => PosPresenter::session($row->refresh())], 200, self::NO_STORE);
    }

    public static function findRegister(Store $store, string $id): PosRegister
    {
        return PosRegister::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    public static function findSession(Store $store, string $id): PosSession
    {
        return PosSession::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private function register(PosRegister $register, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => PosPresenter::register($register->refresh()->load('location'))], $status, self::NO_STORE);
    }
}
