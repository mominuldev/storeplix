<?php

declare(strict_types=1);

namespace App\Domain\Reports;

use App\Domain\Geo\BdGeo;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;

/**
 * Sales overview (PHASE-7-CONTRACT §6.4): orders by `placed_at` in range. Sold orders = status shipped | delivered;
 * net = total − refunded. Aggregated in PHP from one bounded row set per period (portable across sqlite/Postgres and
 * exact for store-local days).
 */
final class SalesReport
{
    public const SOLD = [Order::SHIPPED, Order::DELIVERED];

    public const DHAKA = 'dhaka';

    public function __construct(private readonly BdGeo $geo) {}

    /** @return array<string, mixed> SalesReport */
    public function build(Store $store, ReportRange $range): array
    {
        $rows = $this->rows($store, $range);
        $sold = array_values(array_filter($rows, fn (object $r) => in_array($r->status, self::SOLD, true)));
        $soldIds = array_map(fn (object $r) => (string) $r->id, $sold);
        $items = $this->items($store, $range);

        $summary = $this->summary($rows, $range, $items['units']);

        // Daily buckets (zeros included), best day, weekend share (Friday + Saturday).
        $daily = [];
        foreach ($range->dates() as $date) {
            $daily[$date] = ['date' => $date, 'orders_count' => 0, 'sold_orders_count' => 0, 'sales_amount' => 0];
        }
        foreach ($rows as $r) {
            $date = $range->localDate($r->placed_at);
            if (! isset($daily[$date])) {
                continue;
            }
            $daily[$date]['orders_count']++;
            if (in_array($r->status, self::SOLD, true)) {
                $daily[$date]['sold_orders_count']++;
                $daily[$date]['sales_amount'] += self::net($r);
            }
        }
        $best = null;
        $weekend = 0;
        foreach ($daily as $date => $day) {
            if ($day['sales_amount'] > 0 && ($best === null || $day['sales_amount'] > $best['sales_amount'])) {
                $best = ['date' => $date, 'sales_amount' => $day['sales_amount'], 'orders_count' => $day['orders_count']];
            }
            $dow = (int) date('N', (int) strtotime($date.' 12:00:00 UTC')); // 5 = Friday, 6 = Saturday
            if ($dow === 5 || $dow === 6) {
                $weekend += $day['sales_amount'];
            }
        }

        // Channels over sold orders.
        $channels = [];
        foreach ($sold as $r) {
            $channels[$r->channel] ??= ['channel' => (string) $r->channel, 'orders_count' => 0, 'sales_amount' => 0, 'share' => 0.0];
            $channels[$r->channel]['orders_count']++;
            $channels[$r->channel]['sales_amount'] += self::net($r);
        }
        $channels = array_values(array_filter($channels, fn (array $c) => $c['sales_amount'] !== 0));
        foreach ($channels as &$c) {
            $c['share'] = ReportMath::share($c['sales_amount'], $summary['sales_amount']);
        }
        unset($c);
        usort($channels, fn (array $a, array $b) => [$b['sales_amount'], $a['channel']] <=> [$a['sales_amount'], $b['channel']]);

        // Areas over sold orders. PHASE-8-8D P88D-22: till sales (created_via pos, walk-in sentinels) have no delivery
        // area, so they are skipped here; shares are of the delivered-to sales (they count in totals and channels).
        $districts = [];
        $inside = 0;
        $areaSales = 0;
        foreach ($sold as $r) {
            if ($r->created_via === Order::VIA_POS) {
                continue;
            }
            $areaSales += self::net($r);
            $code = (string) $r->district_code;
            $districts[$code] ??= ['district_code' => $code, 'district_name' => $this->geo->district($code)['name'] ?? $code,
                'orders_count' => 0, 'sales_amount' => 0, 'share' => 0.0];
            $districts[$code]['orders_count']++;
            $districts[$code]['sales_amount'] += self::net($r);
            if ($code === self::DHAKA) {
                $inside += self::net($r);
            }
        }
        $districts = array_values($districts);
        usort($districts, fn (array $a, array $b) => [$b['orders_count'], $b['sales_amount'], $a['district_code']] <=> [$a['orders_count'], $a['sales_amount'], $b['district_code']]);
        $districts = array_slice($districts, 0, 8);
        foreach ($districts as &$d) {
            $d['share'] = ReportMath::share($d['sales_amount'], $areaSales);
        }
        unset($d);

        return [
            'summary' => $summary,
            'previous' => $this->summary($this->rows($store, $range->previous()), $range->previous(), $this->items($store, $range->previous())['units']),
            'best_day' => $best,
            'weekend_share' => ReportMath::ratio($weekend, $summary['sales_amount']),
            'daily' => array_values($daily),
            'channels' => $channels,
            'top_products' => $items['top'],
            'areas' => [
                'inside_dhaka_share' => ReportMath::ratio($inside, $areaSales),
                'districts' => $districts,
            ],
        ];
    }

    /** @param list<object> $rows @return array<string, mixed> SalesSummary */
    private function summary(array $rows, ReportRange $range, int $units): array
    {
        $orders = count($rows);
        $soldCount = 0;
        $sales = 0;
        $cancelled = 0;
        $fake = 0;
        foreach ($rows as $r) {
            if (in_array($r->status, self::SOLD, true)) {
                $soldCount++;
                $sales += self::net($r);
            } elseif ($r->status === Order::CANCELLED) {
                $cancelled++;
                if ($r->cancel_reason === 'fake_order') {
                    $fake++;
                }
            }
        }

        return [
            'sales_amount' => $sales,
            'sold_orders_count' => $soldCount,
            'orders_count' => $orders,
            'orders_per_day' => ReportMath::oneDecimal($orders, $range->elapsedDays()) ?? 0.0,
            'average_order_value_amount' => ReportMath::perUnit($sales, $soldCount),
            'items_per_order' => ReportMath::oneDecimal($units, $soldCount),
            'cancelled_count' => $cancelled,
            'cancelled_rate' => ReportMath::ratio($cancelled, $orders),
            'fake_cancelled_count' => $fake,
        ];
    }

    /** @return list<object> */
    private function rows(Store $store, ReportRange $range): array
    {
        return ReportMath::orders($store->tenant_id, $store->id)
            ->where('orders.placed_at', '>=', $range->startUtc())
            ->where('orders.placed_at', '<', $range->endUtc())
            ->orderBy('orders.placed_at')
            ->get(['orders.id', 'orders.status', 'orders.total_amount', 'orders.refunded_amount', 'orders.cancel_reason',
                'orders.channel', 'orders.district_code', 'orders.placed_at', 'orders.created_via'])
            ->all();
    }

    /**
     * Items of the sold orders: total units (items_per_order) and the top 6 products by line net.
     *
     * @return array{units: int, top: list<array<string, mixed>>}
     */
    private function items(Store $store, ReportRange $range): array
    {
        $sold = DB::table('orders')->select('orders.id')
            ->where('orders.tenant_id', $store->tenant_id)->where('orders.store_id', $store->id)
            ->whereIn('orders.status', self::SOLD)
            ->where('orders.placed_at', '>=', $range->startUtc())->where('orders.placed_at', '<', $range->endUtc());

        $lines = DB::table('order_items')
            ->where('order_items.tenant_id', $store->tenant_id)->where('order_items.store_id', $store->id)
            ->whereIn('order_items.order_id', $sold)
            ->groupBy('order_items.product_id', 'order_items.product_name')
            ->selectRaw('order_items.product_id, order_items.product_name, SUM(order_items.quantity) AS units, SUM(order_items.total_amount) AS amount, MAX(order_items.image_media_id) AS media_id, MAX(order_items.created_at) AS last_at')
            ->get();

        $groups = [];
        $units = 0;
        $total = 0;
        foreach ($lines as $line) {
            $key = $line->product_id !== null ? 'id:'.$line->product_id : 'name:'.$line->product_name;
            $groups[$key] ??= ['product_id' => $line->product_id, 'name' => (string) $line->product_name, 'media_id' => null,
                'units' => 0, 'sales_amount' => 0, 'last_at' => ''];
            $groups[$key]['units'] += (int) $line->units;
            $groups[$key]['sales_amount'] += (int) $line->amount;
            if ((string) $line->last_at >= $groups[$key]['last_at']) {
                $groups[$key]['name'] = (string) $line->product_name; // latest name
                $groups[$key]['last_at'] = (string) $line->last_at;
            }
            $groups[$key]['media_id'] ??= $line->media_id;
            $units += (int) $line->units;
            $total += (int) $line->amount;
        }
        $groups = array_values($groups);
        usort($groups, fn (array $a, array $b) => [$b['sales_amount'], $b['units'], $a['name']] <=> [$a['sales_amount'], $a['units'], $b['name']]);
        $groups = array_slice($groups, 0, 6);

        $media = MediaMaps::load(array_values(array_filter(array_column($groups, 'media_id'))));
        $top = array_map(fn (array $g) => [
            'product_id' => $g['product_id'] !== null ? (string) $g['product_id'] : null,
            'name' => $g['name'],
            'image' => MediaPresenter::ref($g['media_id'] !== null ? ($media[$g['media_id']] ?? null) : null),
            'units' => $g['units'],
            'sales_amount' => $g['sales_amount'],
            'share' => ReportMath::share($g['sales_amount'], $total),
        ], $groups);

        return ['units' => $units, 'top' => $top];
    }

    private static function net(object $r): int
    {
        return (int) $r->total_amount - (int) $r->refunded_amount;
    }
}
