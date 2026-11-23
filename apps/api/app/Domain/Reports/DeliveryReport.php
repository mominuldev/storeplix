<?php

declare(strict_types=1);

namespace App\Domain\Reports;

use App\Domain\Geo\BdGeo;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Delivery & returns (PHASE-7-CONTRACT §6.4): courier shipments (provider ≠ manual) booked in range, excluding
 * cancelled and booking_failed. No customer phone or address leaves this report (S63): names + district only.
 */
final class DeliveryReport
{
    public const DELIVERED = [Shipment::DELIVERED, Shipment::PARTIALLY_DELIVERED];

    public const EXCLUDED = [Shipment::CANCELLED, Shipment::BOOKING_FAILED];

    public function __construct(private readonly BdGeo $geo) {}

    /** @return array<string, mixed> DeliveryReport */
    public function build(Store $store, ReportRange $range): array
    {
        $rows = $this->parcels($store, $range->startUtc(), $range->endUtc());
        $previous = $range->previous();

        // Couriers.
        $byProvider = [];
        foreach ($rows as $r) {
            $byProvider[$r->provider][] = $r;
        }
        $held = $this->codHeld($store);
        $couriers = [];
        foreach ($byProvider as $provider => $list) {
            $s = $this->summary($list);
            $couriers[] = [
                'provider' => (string) $provider,
                'parcels_count' => $s['parcels_count'],
                'delivered_share' => ReportMath::share($s['delivered_count'], $s['parcels_count']),
                'returned_share' => ReportMath::share($s['returned_count'], $s['parcels_count']),
                'in_progress_share' => ReportMath::share($s['parcels_count'] - $s['delivered_count'] - $s['returned_count'], $s['parcels_count']),
                'avg_delivery_days' => $s['avg_delivery_days'],
                'cod_held_amount' => (int) ($held[$provider] ?? 0),
            ];
        }
        usort($couriers, fn (array $a, array $b) => [$b['parcels_count'], $a['provider']] <=> [$a['parcels_count'], $b['provider']]);

        // Return reasons over return requests created in range.
        $reasons = DB::table('return_requests')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)
            ->where('created_at', '>=', $range->startUtc())->where('created_at', '<', $range->endUtc())
            ->groupBy('reason')->selectRaw('reason, COUNT(*) AS c')->pluck('c', 'reason');
        $returns = (int) $reasons->sum();
        $returnReasons = [];
        foreach ($reasons as $reason => $count) {
            $returnReasons[] = ['reason' => (string) $reason, 'count' => (int) $count, 'share' => ReportMath::share((int) $count, $returns)];
        }
        usort($returnReasons, fn (array $a, array $b) => [$b['count'], $a['reason']] <=> [$a['count'], $b['reason']]);

        // Weekly success (8 ISO weeks ending with the week of `to`).
        [$wStart, $wEnd] = $range->weeksWindowUtc(8);
        $weekRows = $this->parcels($store, $wStart, $wEnd);
        $weekly = [];
        foreach ($range->isoWeeks(8) as $week) {
            $list = array_values(array_filter($weekRows, fn (object $r) => $range->localWeek($r->booked_at) === $week['week']));
            $s = $this->summary($list);
            $weekly[] = $week + ['parcels_count' => $s['parcels_count'], 'success_rate' => $s['success_rate']];
        }

        // Districts (top 16 by parcels).
        $districts = [];
        foreach ($rows as $r) {
            $districts[$r->district_code][] = $r;
        }
        $districtsOut = [];
        foreach ($districts as $code => $list) {
            $s = $this->summary($list);
            $districtsOut[] = ['district_code' => (string) $code, 'district_name' => $this->geo->district((string) $code)['name'] ?? (string) $code,
                'parcels_count' => $s['parcels_count'], 'success_rate' => $s['success_rate']];
        }
        usort($districtsOut, fn (array $a, array $b) => [$b['parcels_count'], $a['district_code']] <=> [$a['parcels_count'], $b['district_code']]);

        return [
            'summary' => $this->summary($rows),
            'previous' => $this->summary($this->parcels($store, $previous->startUtc(), $previous->endUtc())),
            'couriers' => $couriers,
            'returns_count' => $returns,
            'return_reasons' => $returnReasons,
            'weekly' => $weekly,
            'returning' => $this->returning($store),
            'districts' => array_slice($districtsOut, 0, 16),
        ];
    }

    /** @param list<object> $rows @return array<string, mixed> DeliverySummary */
    private function summary(array $rows): array
    {
        $parcels = count($rows);
        $delivered = $returned = $returning = 0;
        $charges = 0;
        $days = ['all' => [], 'in' => [], 'out' => []];
        foreach ($rows as $r) {
            if (in_array($r->status, self::DELIVERED, true)) {
                $delivered++;
                if ($r->delivered_at !== null) {
                    $from = ReportRange::parse($r->picked_up_at ?? $r->booked_at);
                    $d = ($from->diffInSeconds(ReportRange::parse($r->delivered_at), false)) / 86400;
                    $days['all'][] = $d;
                    $days[$r->district_code === SalesReport::DHAKA ? 'in' : 'out'][] = $d;
                }
            } elseif ($r->status === Shipment::RETURNED) {
                $returned++;
                $charges += (int) ($r->delivery_fee_amount ?? 0);
            } elseif ($r->status === Shipment::RETURNING) {
                $returning++;
                $charges += (int) ($r->delivery_fee_amount ?? 0);
            }
        }
        $avg = fn (array $list) => $list === [] ? null : round(array_sum($list) / count($list), 1);

        return [
            'parcels_count' => $parcels,
            'delivered_count' => $delivered,
            'returned_count' => $returned,
            'returning_count' => $returning,
            'in_progress_count' => $parcels - $delivered - $returned - $returning,
            'success_rate' => ReportMath::ratio($delivered, $parcels),
            'return_rate' => ReportMath::ratio($returned, $parcels),
            'returning_charges_amount' => $charges,
            'avg_delivery_days' => $avg($days['all']),
            'avg_delivery_days_inside_dhaka' => $avg($days['in']),
            'avg_delivery_days_outside_dhaka' => $avg($days['out']),
        ];
    }

    /** @return list<object> */
    private function parcels(Store $store, CarbonImmutable $start, CarbonImmutable $end): array
    {
        return DB::table('shipments')
            ->join('orders', fn ($j) => $j->on('orders.id', '=', 'shipments.order_id')->on('orders.tenant_id', '=', 'shipments.tenant_id'))
            ->where('shipments.tenant_id', $store->tenant_id)->where('shipments.store_id', $store->id)
            ->where('shipments.provider', '<>', Shipment::MANUAL)
            ->whereNotIn('shipments.status', self::EXCLUDED)
            ->whereNotNull('shipments.booked_at')
            ->where('shipments.booked_at', '>=', $start)->where('shipments.booked_at', '<', $end)
            ->get(['shipments.provider', 'shipments.status', 'shipments.delivery_fee_amount', 'shipments.booked_at',
                'shipments.picked_up_at', 'shipments.delivered_at', 'orders.district_code'])
            ->all();
    }

    /** Q49 COD held: collected COD of delivered courier shipments of the last 60 days, not settled. @return array<string, int> */
    private function codHeld(Store $store): array
    {
        return DB::table('shipments')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)
            ->whereIn('status', self::DELIVERED)->whereNull('settled_at')->where('provider', '<>', Shipment::MANUAL)
            ->where('delivered_at', '>=', CarbonImmutable::now()->subDays(60))
            ->groupBy('provider')->selectRaw('provider, COALESCE(SUM(cod_collected_amount), 0) AS amount')
            ->pluck('amount', 'provider')->map(fn ($v) => (int) $v)->all();
    }

    /** Up to 5 parcels on the way back, oldest last event first. @return list<array<string, mixed>> */
    private function returning(Store $store): array
    {
        $rows = DB::table('shipments')
            ->join('orders', fn ($j) => $j->on('orders.id', '=', 'shipments.order_id')->on('orders.tenant_id', '=', 'shipments.tenant_id'))
            ->where('shipments.tenant_id', $store->tenant_id)->where('shipments.store_id', $store->id)
            ->where('shipments.provider', '<>', Shipment::MANUAL)
            ->where('shipments.status', Shipment::RETURNING)
            ->orderByRaw('CASE WHEN shipments.last_event_at IS NULL THEN 1 ELSE 0 END')
            ->orderBy('shipments.last_event_at')->orderBy('shipments.id')
            ->limit(5)
            ->get(['shipments.id', 'shipments.order_id', 'orders.number', 'orders.customer_name', 'orders.district_code',
                'shipments.provider', 'shipments.problem', 'shipments.last_location', 'shipments.last_event_at']);

        return $rows->map(fn (object $r) => [
            'shipment_id' => (string) $r->id,
            'order_id' => (string) $r->order_id,
            'order_number' => (string) $r->number,
            'customer_name' => (string) $r->customer_name,
            'district_name' => $this->geo->district((string) $r->district_code)['name'] ?? null,
            'provider' => (string) $r->provider,
            'problem' => $r->problem !== null ? (string) $r->problem : null,
            'last_location' => $r->last_location !== null ? (string) $r->last_location : null,
            'last_event_at' => $r->last_event_at !== null ? ReportRange::parse($r->last_event_at)->toIso8601ZuluString() : null,
        ])->all();
    }
}
