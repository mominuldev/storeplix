<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Controllers;

use App\Domain\Pos\Http\Requests\PosHeldSaleRequest;
use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\PosHeldSaleService;
use App\Domain\Pos\PosPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-8D §9 (part B) `/stores/{store}/pos/held-sales…`: list per register (newest first), hold (plan `pos`,
 * ≤ 20 per register, 409 `held_sales_limit`), detail (the client re-prices with POST /pos/quote), delete (audited).
 * `{held}` of another store or tenant → 404 (S195).
 */
class PosHeldSaleController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly PosHeldSaleService $held) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate(['register_id' => ['required', 'string', 'size:26']]);
        $register = PosRegister::query()->where('store_id', $store->id)->whereKey(strtolower($input['register_id']))->value('id')
            ?? throw ValidationException::withMessages(['register_id' => ['Unknown register.']]);
        $rows = PosHeldSale::query()->where('store_id', $store->id)->where('register_id', $register)->with('heldBy')
            ->orderByDesc('created_at')->orderByDesc('id')->get();

        return new JsonResponse(['data' => $rows->map(fn (PosHeldSale $h) => PosPresenter::heldSale($h))->values()->all()], 200, self::NO_STORE);
    }

    public function store(PosHeldSaleRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        if (isset($input['customer']['phone'])) {
            $input['customer']['phone'] = Phone::bdMsisdn($input['customer']['phone']);
        }

        return new JsonResponse(['data' => PosPresenter::heldSale($this->held->hold($store, $input, $request->user()))], 201, self::NO_STORE);
    }

    public function show(Store $store, string $held): JsonResponse
    {
        return new JsonResponse(['data' => PosPresenter::heldSale(self::find($store, $held))], 200, self::NO_STORE);
    }

    public function destroy(Store $store, string $held): Response
    {
        $this->held->delete($store, self::find($store, $held));

        return response()->noContent();
    }

    private static function find(Store $store, string $id): PosHeldSale
    {
        return PosHeldSale::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
