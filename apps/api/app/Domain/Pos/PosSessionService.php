<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Orders\Models\Payment;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Cash sessions (PHASE-8-8D §4, §6.2, P88D-5, P88D-15, S201). Open: one open session per register (the partial unique
 * index is the final guard against a parallel open). Close: the session row FOR UPDATE (a sale holds it FOR SHARE, so a
 * sale either commits before the close and is counted, or sees `closed` → 409 `register_closed`), expected cash
 * computed from the session's payment rows under the lock, never from the client. Both audited (P88D-23).
 */
final class PosSessionService
{
    /** By-method order on the close screen (P88D-9). */
    public const METHODS = ['cash', 'bkash_personal', 'card'];

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array{counts?: array<string, int>, opening_cash_amount?: int, note?: string|null} $input */
    public function open(Store $store, PosRegister $register, array $input, User $user): PosSession
    {
        $currency = $store->currency ?: 'BDT';
        $counts = $input['counts'] ?? null; // counts win when both are sent
        $amount = $counts !== null ? PosMoney::countsTotal($counts, $currency) : (int) ($input['opening_cash_amount'] ?? 0);

        try {
            return DB::transaction(function () use ($store, $register, $counts, $amount, $currency, $input, $user) {
                /** @var PosRegister $row */
                $row = PosRegister::query()->where('store_id', $store->id)->whereKey($register->id)->lockForUpdate()->firstOrFail();
                if ($row->isArchived()) {
                    throw new ApiException(422, 'register_archived', 'This register is archived. Unarchive it first.');
                }
                Locations::resolve($store->id, $row->location_id, 'register_id'); // archived location → 422 location_archived
                $open = PosSession::query()->where('register_id', $row->id)->where('status', PosSession::OPEN)->first();
                if ($open !== null) {
                    throw self::alreadyOpen($open->id);
                }

                $session = new PosSession;
                $session->store_id = $store->id;
                $session->register_id = $row->id;
                $session->location_id = $row->location_id;
                $session->status = PosSession::OPEN;
                $session->currency = $currency;
                $session->opened_by = $user->id;
                $session->opened_at = now();
                $session->opening_cash_amount = $amount;
                $session->opening_counts = $counts !== null ? PosMoney::normaliseCounts($counts) : null;
                $session->save();
                $this->audit->log('pos_session.opened', $session, [
                    'register_id' => $row->id, 'opening_cash_amount' => $amount, 'counts' => $session->opening_counts,
                    'note' => $input['note'] ?? null,
                ]);

                return $session;
            });
        } catch (UniqueConstraintViolationException) {
            $winner = PosSession::query()->where('register_id', $register->id)->where('status', PosSession::OPEN)->value('id');
            throw self::alreadyOpen((string) $winner);
        }
    }

    /**
     * @param  array{counts?: array<string, int>, counted_cash_amount?: int, left_in_drawer_amount: int, note?: string|null, revision: int}  $input
     */
    public function close(Store $store, PosSession $session, array $input, User $user): PosSession
    {
        return DB::transaction(function () use ($store, $session, $input, $user) {
            /** @var PosSession $row */
            $row = PosSession::query()->where('store_id', $store->id)->whereKey($session->id)->lockForUpdate()->firstOrFail();
            if (! $row->isOpen()) {
                throw new ApiException(409, 'invalid_state_transition', 'This register is already closed.');
            }
            if ((int) $input['revision'] !== $row->revision) {
                throw new ApiException(409, 'revision_conflict', 'This register changed since you opened it. Reload and try again.', ['revision' => $row->revision]);
            }
            $counts = $input['counts'] ?? null;
            $counted = $counts !== null ? PosMoney::countsTotal($counts, $row->currency) : (int) ($input['counted_cash_amount'] ?? 0);
            $totals = self::totals($row);
            $expected = $totals['cash_in_drawer_amount'];
            $left = (int) $input['left_in_drawer_amount'];
            $note = isset($input['note']) && trim((string) $input['note']) !== '' ? trim((string) $input['note']) : null;
            ['variance_amount' => $variance, 'banked_amount' => $banked] = PosMoney::close($counted, $expected, $left, $note, self::tolerance());

            $row->status = PosSession::CLOSED;
            $row->closed_by = $user->id;
            $row->closed_at = now();
            $row->counted_cash_amount = $counted;
            $row->closing_counts = $counts !== null ? PosMoney::normaliseCounts($counts) : null;
            $row->expected_cash_amount = $expected;
            $row->variance_amount = $variance;
            $row->left_in_drawer_amount = $left;
            $row->banked_amount = $banked;
            $row->close_note = $note;
            $row->revision++;
            $row->save();
            // Held sales of the register are deleted here (P88D-15) once part B adds them; none exist in part A.
            $this->audit->log('pos_session.closed', $row, [
                'register_id' => $row->register_id, 'counted_cash_amount' => $counted, 'expected_cash_amount' => $expected,
                'variance_amount' => $variance, 'left_in_drawer_amount' => $left, 'banked_amount' => $banked, 'note' => $note,
                'held_sales_deleted' => 0,
            ]);

            return $row;
        });
    }

    public static function tolerance(): int
    {
        return (int) config('pos.variance_tolerance_amount', 5000);
    }

    /**
     * PosSessionTotals (§4, §6.2): live for an open session, the Z-report figures for a closed one. Cash in drawer =
     * opening + Σ succeeded cash charges − Σ succeeded cash refunds bound to the session.
     *
     * @return array<string, mixed>
     */
    public static function totals(PosSession $session): array
    {
        $rows = Payment::query()->where('store_id', $session->store_id)->where('pos_session_id', $session->id)
            ->where('status', Payment::STATUS_SUCCEEDED)->toBase()
            ->groupBy('type', 'method')->selectRaw('type, method, count(*) as n, coalesce(sum(amount), 0) as total')->get();
        $charges = array_fill_keys(self::METHODS, ['amount' => 0, 'count' => 0]);
        $cashRefunds = 0;
        $refunds = ['amount' => 0, 'count' => 0];
        foreach ($rows as $r) {
            if ($r->type === Payment::TYPE_CHARGE && isset($charges[$r->method])) {
                $charges[$r->method] = ['amount' => (int) $r->total, 'count' => (int) $r->n];
            } elseif ($r->type === Payment::TYPE_REFUND) {
                $refunds['amount'] += (int) $r->total;
                $refunds['count'] += (int) $r->n;
                if ($r->method === 'cash') {
                    $cashRefunds += (int) $r->total;
                }
            }
        }
        $sales = PosSale::query()->where('pos_sales.store_id', $session->store_id)->where('pos_sales.session_id', $session->id)
            ->join('orders', 'orders.id', '=', 'pos_sales.order_id')->toBase()
            ->selectRaw('count(*) as n, coalesce(sum(orders.total_amount), 0) as total, coalesce(sum(orders.discount_amount), 0) as discounts')->first();

        $byMethod = [];
        foreach ($charges as $method => $c) {
            $byMethod[] = ['method' => $method, 'amount' => $c['amount'], 'count' => $c['count']];
        }

        return [
            'cash_in_drawer_amount' => PosMoney::expectedCash($session->opening_cash_amount, $charges['cash']['amount'], $cashRefunds),
            'cash_sales_amount' => $charges['cash']['amount'],
            'cash_refunds_amount' => $cashRefunds,
            'sales_amount' => (int) ($sales->total ?? 0),
            'receipts_count' => (int) ($sales->n ?? 0),
            'by_method' => $byMethod,
            'returns_count' => $refunds['count'],
            'returns_amount' => $refunds['amount'],
            'discounts_amount' => (int) ($sales->discounts ?? 0),
            'held_sales_count' => 0, // part B (pos_held_sales)
        ];
    }

    /** Left in drawer at the register's previous close (the open hint, P88D-15). */
    public static function lastClosingLeft(string $registerId, ?PosSession $before = null): ?int
    {
        $value = PosSession::query()->where('register_id', $registerId)->where('status', PosSession::CLOSED)
            ->when($before !== null, fn ($q) => $q->whereKeyNot($before->id)->where('closed_at', '<=', $before->opened_at))
            ->orderByDesc('closed_at')->orderByDesc('id')->value('left_in_drawer_amount');

        return $value === null ? null : (int) $value;
    }

    private static function alreadyOpen(string $sessionId): ApiException
    {
        return new ApiException(409, 'register_already_open', 'This register is already open. Join it or close it first.', ['session_id' => $sessionId]);
    }
}
