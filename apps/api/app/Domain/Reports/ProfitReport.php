<?php

declare(strict_types=1);

namespace App\Domain\Reports;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Profit & loss (PHASE-7-CONTRACT §6.4): delivered orders (status `delivered`) by `delivered_at`.
 * revenue = Σ net; product cost = Σ unit_cost × (quantity − returned quantity); delivery cost / COD fee from the
 * order's delivered shipment(s). Gateway fees and ad spend are not tracked (null).
 */
final class ProfitReport
{
    /** Return requests whose items are back with the merchant (returned quantity). */
    public const RETURNED_STATUSES = ['received', 'refunded', 'exchanged'];

    /** @return array<string, mixed> ProfitReport */
    public function build(Store $store, ReportRange $range): array
    {
        $orders = $this->orders($store, $range->startUtc(), $range->endUtc());
        $summary = self::summary($orders['rows']);

        $daily = [];
        foreach (array_reverse($range->dates()) as $date) {
            $daily[$date] = [];
        }
        foreach ($orders['rows'] as $row) {
            $date = $range->localDate($row['delivered_at']);
            if (isset($daily[$date])) {
                $daily[$date][] = $row;
            }
        }
        $dailyOut = [];
        foreach ($daily as $date => $rows) {
            $s = self::summary($rows);
            unset($s['delivered_orders_count'], $s['profit_per_order_amount']);
            $dailyOut[] = ['date' => $date, 'orders_count' => count($rows)] + $s;
        }

        [$wStart, $wEnd] = $range->weeksWindowUtc(12);
        $weekRows = $this->orders($store, $wStart, $wEnd)['rows'];
        $weekly = [];
        foreach ($range->isoWeeks(12) as $week) {
            $rows = array_values(array_filter($weekRows, fn (array $r) => $range->localWeek($r['delivered_at']) === $week['week']));
            $s = self::summary($rows);
            $weekly[] = $week + ['revenue_amount' => $s['revenue_amount'], 'net_profit_amount' => $s['net_profit_amount'], 'margin' => $s['margin']];
        }

        $n = $summary['delivered_orders_count'];
        $previous = $range->previous();

        return [
            'summary' => $summary,
            'previous' => self::summary($this->orders($store, $previous->startUtc(), $previous->endUtc())['rows']),
            'per_order' => $n === 0 ? null : [
                'order_value_amount' => ReportMath::perUnit($summary['revenue_amount'], $n),
                'product_cost_amount' => ReportMath::perUnit($summary['product_cost_amount'], $n),
                'delivery_cost_amount' => ReportMath::perUnit($summary['delivery_cost_amount'], $n),
                'cod_fee_amount' => ReportMath::perUnit($summary['cod_fee_amount'], $n),
                'gateway_fee_amount' => null,
                'profit_amount' => ReportMath::perUnit($summary['net_profit_amount'], $n),
            ],
            'weekly' => $weekly,
            'daily' => $dailyOut,
            'data_quality' => $orders['quality'],
        ];
    }

    /** @param list<array<string, mixed>> $rows @return array<string, mixed> ProfitSummary */
    private static function summary(array $rows): array
    {
        $revenue = array_sum(array_column($rows, 'revenue'));
        $product = array_sum(array_column($rows, 'product_cost'));
        $delivery = array_sum(array_column($rows, 'delivery_cost'));
        $cod = array_sum(array_column($rows, 'cod_fee'));
        $cost = $product + $delivery + $cod; // gateway fees and ad spend are null (not tracked)
        $profit = $revenue - $cost;
        $count = count($rows);

        return [
            'revenue_amount' => $revenue,
            'delivered_orders_count' => $count,
            'product_cost_amount' => $product,
            'delivery_cost_amount' => $delivery,
            'cod_fee_amount' => $cod,
            'gateway_fee_amount' => null,
            'ad_spend_amount' => null,
            'total_cost_amount' => $cost,
            'net_profit_amount' => $profit,
            'margin' => ReportMath::ratio($profit, $revenue),
            'profit_per_order_amount' => ReportMath::perUnit($profit, $count),
        ];
    }

    /**
     * Per delivered order in [start, end): revenue and costs; plus the data-quality counters.
     *
     * @return array{rows: list<array{id: string, delivered_at: mixed, revenue: int, product_cost: int, delivery_cost: int, cod_fee: int}>, quality: array{items_without_cost: int, shipments_without_fee: int}}
     */
    private function orders(Store $store, CarbonImmutable $start, CarbonImmutable $end): array
    {
        $t = $store->tenant_id;
        $s = $store->id;
        $base = fn () => DB::table('orders')->where('orders.tenant_id', $t)->where('orders.store_id', $s)
            ->where('orders.status', Order::DELIVERED)
            ->where('orders.delivered_at', '>=', $start)->where('orders.delivered_at', '<', $end);

        $rows = [];
        foreach ($base()->get(['orders.id', 'orders.total_amount', 'orders.refunded_amount', 'orders.delivered_at']) as $o) {
            $rows[(string) $o->id] = ['id' => (string) $o->id, 'delivered_at' => $o->delivered_at,
                'revenue' => (int) $o->total_amount - (int) $o->refunded_amount, 'product_cost' => 0, 'delivery_cost' => 0, 'cod_fee' => 0];
        }
        $quality = ['items_without_cost' => 0, 'shipments_without_fee' => 0];
        if ($rows === []) {
            return ['rows' => [], 'quality' => $quality];
        }

        $ids = $base()->select('orders.id');
        $returned = DB::table('return_items')
            ->join('return_requests', fn ($j) => $j->on('return_requests.id', '=', 'return_items.return_request_id')
                ->on('return_requests.tenant_id', '=', 'return_items.tenant_id'))
            ->where('return_items.tenant_id', $t)->where('return_items.store_id', $s)
            ->whereIn('return_requests.status', self::RETURNED_STATUSES)
            ->groupBy('return_items.order_item_id')
            ->selectRaw('return_items.order_item_id, SUM(return_items.quantity) AS qty')
            ->whereIn('return_requests.order_id', $ids)
            ->pluck('qty', 'order_item_id');

        $items = DB::table('order_items')->where('tenant_id', $t)->where('store_id', $s)->whereIn('order_id', $ids)
            ->get(['id', 'order_id', 'quantity', 'unit_cost_amount']);
        foreach ($items as $item) {
            if ($item->unit_cost_amount === null) {
                $quality['items_without_cost']++;

                continue;
            }
            $kept = max(0, (int) $item->quantity - (int) ($returned[$item->id] ?? 0));
            $rows[(string) $item->order_id]['product_cost'] += (int) $item->unit_cost_amount * $kept;
        }

        $shipments = DB::table('shipments')->where('tenant_id', $t)->where('store_id', $s)->whereIn('order_id', $ids)
            ->whereIn('status', [Shipment::DELIVERED, Shipment::PARTIALLY_DELIVERED])
            ->get(['order_id', 'provider', 'delivery_fee_amount', 'cod_charge_amount']);
        foreach ($shipments as $sh) {
            if ($sh->provider === Shipment::MANUAL || $sh->delivery_fee_amount === null) {
                $quality['shipments_without_fee']++;
            }
            $rows[(string) $sh->order_id]['delivery_cost'] += (int) ($sh->delivery_fee_amount ?? 0);
            $rows[(string) $sh->order_id]['cod_fee'] += (int) ($sh->cod_charge_amount ?? 0);
        }

        return ['rows' => array_values($rows), 'quality' => $quality];
    }
}
