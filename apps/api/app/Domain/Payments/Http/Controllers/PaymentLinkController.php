<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Models\Order;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

/** §4.4 payment links (merchant; O A S `Operate`). `{order}` / `{link}` of another store or order → 404. */
class PaymentLinkController
{
    public function __construct(private readonly PaymentLinkService $links) {}

    public function index(Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        $store->loadMissing('primaryDomain');
        $links = PaymentLink::query()->where('order_id', $order->id)->with('creator')->orderByDesc('created_at')->orderByDesc('id')->get();

        return new JsonResponse(['data' => $links->map(fn (PaymentLink $l) => PaymentPresenter::link($l, $store))->values()->all()]);
    }

    public function store(Request $request, Store $store, Order $order): JsonResponse
    {
        Gate::authorize('view', $store);
        // S39: only these keys are read; status, amount (for non-custom kinds) and tokens are never taken from input.
        $input = $request->validate([
            'amount_kind' => ['required', 'string', Rule::in(PaymentLink::AMOUNT_KINDS)],
            'percent_bps' => ['nullable', 'integer:strict', 'min:1', 'max:10000'],
            'amount' => ['required_if:amount_kind,custom', 'nullable', 'integer:strict', 'min:1', 'max:1000000000000'],
            'provider' => ['required', 'string', 'in:bkash,sslcommerz'],
            'expires_in_minutes' => ['required', 'integer', Rule::in(PaymentLink::EXPIRY_MINUTES)],
            'cancel_if_unpaid' => ['required', 'boolean'],
            'send_sms' => ['required', 'boolean'],
        ]);
        $link = $this->links->create($order, [
            'amount_kind' => $input['amount_kind'],
            'percent_bps' => $input['percent_bps'] ?? null,
            'amount' => $input['amount'] ?? null,
            'provider' => $input['provider'],
            'expires_in_minutes' => (int) $input['expires_in_minutes'],
            'cancel_if_unpaid' => (bool) $input['cancel_if_unpaid'],
            'send_sms' => (bool) $input['send_sms'],
        ], $request->user());

        return new JsonResponse(['data' => PaymentPresenter::link($link->load('creator'), $store->load('primaryDomain'))], 201);
    }

    public function resend(Request $request, Store $store, Order $order, string $link): JsonResponse
    {
        Gate::authorize('view', $store);
        $row = $this->find($order, $link);
        $row = $this->links->resend($row, $request->user());

        return new JsonResponse(['data' => PaymentPresenter::link($row->load('creator'), $store->load('primaryDomain'))]);
    }

    public function destroy(Request $request, Store $store, Order $order, string $link): Response
    {
        Gate::authorize('view', $store);
        $this->links->cancel($this->find($order, $link), $request->user());

        return response()->noContent();
    }

    private function find(Order $order, string $id): PaymentLink
    {
        return PaymentLink::query()->where('order_id', $order->id)->where('store_id', $order->store_id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
