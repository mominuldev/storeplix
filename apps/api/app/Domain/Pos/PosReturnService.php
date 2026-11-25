<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\OrderService;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Returns\Models\ReturnItem;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Returns\ReturnService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Return items at the till (PHASE-8-8D §9, P88D-17, S206), one transaction over existing tested code:
 * ReturnService::create (type `return`, source merchant) → approve → receive with FULL restock (at each line's stored
 * location = the register location, P88C-16) → OrderService::refund (method cash from the drawer, or bKash / card;
 * `pos_session_id` set). Lock order: the order row FOR UPDATE, then the session row FOR UPDATE (stricter than the
 * contract's FOR SHARE: two cash refunds can't both pass the drawer check, and a close sees either both or neither).
 * Exchange = this return, then a new sale (Q250); no void.
 */
final class PosReturnService
{
    public function __construct(
        private readonly ReturnService $returns,
        private readonly OrderService $orders,
    ) {}

    /**
     * @param  array{session_id: string, lines: list<array{order_item_id: string, quantity: int}>, refund_method: string, reason?: string|null, note?: string|null}  $input
     * @return array{return: ReturnRequest, refund: Payment}
     */
    public function return(Store $store, PosSale $sale, array $input, User $user, ?string $idempotencyKey): array
    {
        return DB::transaction(function () use ($store, $sale, $input, $user, $idempotencyKey) {
            /** @var Order $order */
            $order = Order::query()->where('store_id', $store->id)->whereKey($sale->order_id)->lockForUpdate()->firstOrFail();
            $session = PosSession::query()->where('store_id', $store->id)->whereKey(strtolower($input['session_id']))->lockForUpdate()->first();
            if ($session === null) {
                throw ValidationException::withMessages(['session_id' => ['Unknown register session.']]);
            }
            if (! $session->isOpen()) {
                throw new ApiException(409, 'register_closed', 'This register is closed. Open it again to take a return.');
            }
            $note = isset($input['note']) && trim((string) $input['note']) !== '' ? trim((string) $input['note']) : null;

            $return = $this->returns->create($order, [
                'type' => 'return',
                'reason' => $input['reason'] ?? 'other',
                'customer_note' => $note,
                'lines' => array_values($input['lines']),
            ], $user);
            $return = $this->returns->approve($return, null, null, $user);
            $items = ReturnItem::query()->where('return_request_id', $return->id)->orderBy('id')->get();
            $return = $this->returns->receive($return, [
                'checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true],
                'lines' => $items->map(fn (ReturnItem $ri) => ['return_item_id' => $ri->id, 'restock_quantity' => (int) $ri->quantity])->values()->all(),
            ], $user);

            $amount = (int) $return->requested_amount - (int) $return->refunded_amount;
            if ($amount <= 0) {
                throw ValidationException::withMessages(['lines' => ['These items were free: there is nothing to refund.']]);
            }
            if ($input['refund_method'] === 'cash') {
                $inDrawer = PosSessionService::totals($session)['cash_in_drawer_amount'];
                if ($amount > $inDrawer) {
                    $message = 'Only '.Money::bdt(max(0, $inDrawer)).' is in the drawer. Refund '.Money::bdt($amount).' by bKash or card.';
                    throw new ApiException(422, 'drawer_short', $message, ['refund_method' => [$message]]);
                }
            }
            $refund = $this->orders->refund($order, [
                'amount' => $amount,
                'method' => $input['refund_method'],
                'note' => $note,
                'return_id' => $return->id,
                'pos_session_id' => $session->id,
            ], $idempotencyKey, $user);

            return ['return' => $return->refresh(), 'refund' => $refund];
        });
    }
}
