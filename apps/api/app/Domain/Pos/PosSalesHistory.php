<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Orders\Models\Payment;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Sales history (PHASE-8-8D §9): till sales newest first with the KPI summary. Dates are store-local days. Without
 * `filter[date]` the list is today's, unless `q` (exact order number or phone) searches every day.
 *
 * KPIs (over the date range and register filter; method and q only narrow the list): sales = Σ till-sale totals −
 * Σ till refunds in range; receipts = till sales; average = sales ÷ receipts (rounded); returns = count and Σ of till
 * refunds (refund rows with a `pos_session_id`) in range.
 */
final class PosSalesHistory
{
    public const PER_PAGE = 50;

    /**
     * @param  array<string, mixed>  $input  validated query
     * @return array{data: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public function list(Store $store, array $input): array
    {
        $filter = (array) ($input['filter'] ?? []);
        $q = trim((string) ($input['q'] ?? ''));
        $range = self::range($store, $filter['date'] ?? ($q !== '' ? null : 'today'), $input['from'] ?? null, $input['to'] ?? null);
        $registerId = null;
        if (isset($filter['register_id'])) {
            $registerId = PosRegister::query()->where('store_id', $store->id)->whereKey(strtolower((string) $filter['register_id']))->value('id')
                ?? throw ValidationException::withMessages(['filter.register_id' => ['Unknown register.']]);
        }

        $base = fn (): Builder => PosSale::query()->where('pos_sales.store_id', $store->id)
            ->when($range !== null, fn (Builder $w) => $w->where('pos_sales.created_at', '>=', $range[0])->where('pos_sales.created_at', '<', $range[1]))
            ->when($registerId !== null, fn (Builder $w) => $w->where('pos_sales.register_id', $registerId));

        $list = $base();
        if (isset($filter['method'])) {
            $charges = fn ($p) => $p->select('order_id')->from('payments')->where('store_id', $store->id)->where('type', Payment::TYPE_CHARGE)
                ->whereNotNull('pos_session_id')->groupBy('order_id');
            $filter['method'] === 'split'
                ? $list->whereIn('pos_sales.order_id', fn ($p) => $charges($p)->havingRaw('count(*) > 1'))
                : $list->whereIn('pos_sales.order_id', fn ($p) => $charges($p)->havingRaw('count(*) = 1')->havingRaw('max(method) = ?', [$filter['method']]));
        }
        if ($q !== '') {
            $phone = Phone::bdMsisdn($q);
            $list->whereIn('pos_sales.order_id', fn ($o) => $o->select('id')->from('orders')->where('store_id', $store->id)
                ->where(fn ($w) => $w->whereRaw('upper(number) = ?', [mb_strtoupper($q)])->when($phone !== null, fn ($p) => $p->orWhere('customer_phone', $phone))));
        }
        $page = $list->with(['order' => fn ($o) => $o->withSum('items', 'quantity'), 'register', 'cashier'])
            ->orderByDesc('pos_sales.created_at')->orderByDesc('pos_sales.id')
            ->cursorPaginate(self::PER_PAGE, ['pos_sales.*'], 'cursor', $input['cursor'] ?? null);

        $sales = collect($page->items());
        $paidBy = [];
        if ($sales->isNotEmpty()) {
            $rows = Payment::query()->where('store_id', $store->id)->whereIn('order_id', $sales->pluck('order_id')->all())
                ->where('type', Payment::TYPE_CHARGE)->whereNotNull('pos_session_id')->toBase()
                ->groupBy('order_id')->selectRaw('order_id, count(*) as n, max(method) as method')->get();
            foreach ($rows as $r) {
                $paidBy[$r->order_id] = (int) $r->n > 1 ? 'split' : (string) $r->method;
            }
        }
        $data = $sales->map(fn (PosSale $s) => PosPresenter::summary(
            $s, $s->order, (int) ($s->order->items_sum_quantity ?? 0), $paidBy[$s->order_id] ?? 'cash',
            (string) $s->register?->name, (string) $s->cashier?->name,
        ))->values()->all();

        return ['data' => $data, 'meta' => [
            'next_cursor' => $page->nextCursor()?->encode(),
            'prev_cursor' => $page->previousCursor()?->encode(),
            'per_page' => $page->perPage(),
            'summary' => self::summary($store, $base(), $range, $registerId),
        ]];
    }

    /** @param array{0: Carbon, 1: Carbon}|null $range @return array<string, int> */
    private static function summary(Store $store, Builder $sales, ?array $range, ?string $registerId): array
    {
        $totals = $sales->join('orders', 'orders.id', '=', 'pos_sales.order_id')->toBase()
            ->selectRaw('count(*) as n, coalesce(sum(orders.total_amount), 0) as total')->first();
        $refunds = DB::table('payments')->where('payments.store_id', $store->id)->where('payments.type', Payment::TYPE_REFUND)
            ->where('payments.status', Payment::STATUS_SUCCEEDED)->whereNotNull('payments.pos_session_id')
            ->when($range !== null, fn ($w) => $w->where('payments.created_at', '>=', $range[0])->where('payments.created_at', '<', $range[1]))
            ->when($registerId !== null, fn ($w) => $w->whereIn('payments.pos_session_id', fn ($s) => $s->select('id')->from('pos_sessions')->where('register_id', $registerId)))
            ->selectRaw('count(*) as n, coalesce(sum(payments.amount), 0) as total')->first();
        $receipts = (int) ($totals->n ?? 0);
        $sales = (int) ($totals->total ?? 0) - (int) ($refunds->total ?? 0);

        return [
            'sales_amount' => $sales,
            'receipts_count' => $receipts,
            'average_sale_amount' => $receipts > 0 ? (int) round($sales / $receipts) : 0,
            'returns_count' => (int) ($refunds->n ?? 0),
            'returns_amount' => (int) ($refunds->total ?? 0),
        ];
    }

    /**
     * [start, end) in UTC for a store-local date filter; null = every day.
     *
     * @return array{0: Carbon, 1: Carbon}|null
     */
    public static function range(Store $store, ?string $date, ?string $from, ?string $to): ?array
    {
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $today = Carbon::now($tz)->startOfDay();

        return match ($date) {
            null => null,
            'today' => [$today->copy()->utc(), $today->copy()->addDay()->utc()],
            'yesterday' => [$today->copy()->subDay()->utc(), $today->copy()->utc()],
            '7d' => [$today->copy()->subDays(6)->utc(), $today->copy()->addDay()->utc()],
            default => [Carbon::parse((string) $from, $tz)->startOfDay()->utc(), Carbon::parse((string) $to, $tz)->startOfDay()->addDay()->utc()],
        };
    }
}
