<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Automations\Models\Automation;
use App\Domain\Coupons\CouponPresenter;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Http\Resources\CampaignPresenter;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonInterface;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * GET /marketing/overview (PHASE-8-5 §6.1, §6.2, P85-22, §9.1). Every amount: non-cancelled orders' `total_amount`.
 *  - revenue_amount: orders placed in range with a coupon or a campaign conversion (each order once);
 *    revenue_change_pct vs the previous range of the same length (null when that was 0), one decimal;
 *  - campaign_orders (+ share of all non-cancelled orders in range, one decimal);
 *  - messages_sent: campaign recipients `sent` in range; unsubscribes: customer opt-outs (`link`) in range;
 *  - series: 8 ISO weeks (Monday, store timezone), oldest first; an order with a conversion counts as `campaigns`,
 *    else (coupon) as `coupons` — never in both;
 *  - active_coupons: top 4 coupons whose display status is `active`, by revenue; recent_campaigns: latest 5.
 * PHASE-8-6 §9.2 (C14): revenue_amount also counts orders with an automation conversion (each order once);
 * kpis.carts_recovered / recovered_revenue_amount = automation conversions in range (non-cancelled orders);
 * series[].recovery_amount = orders with an automation conversion and no campaign conversion (never in two series);
 * counts.automations = automations `on`.
 */
final class MarketingOverview
{
    public const RANGES = ['7d' => 7, '30d' => 30, '90d' => 90];

    /** @return array<string, mixed> */
    public static function build(Store $store, string $range): array
    {
        $days = self::RANGES[$range];
        $now = now();
        $end = $now->copy()->addSecond(); // includes orders placed this very second
        $from = $now->copy()->subDays($days);
        $prevFrom = $from->copy()->subDays($days);

        $revenue = (int) self::marketingOrders($store, $from, $end)->sum('o.total_amount');
        $previous = (int) self::marketingOrders($store, $prevFrom, $from)->sum('o.total_amount');
        $campaignOrders = self::orders($store, $from, $end)->whereExists(self::conversion())->count();
        $recovered = self::orders($store, $from, $end)->whereExists(self::recovery());
        $allOrders = self::orders($store, $from, $end)->count();

        $tz = (string) ($store->timezone ?: 'Asia/Dhaka');
        $week = Carbon::now($tz)->startOfWeek(CarbonInterface::MONDAY)->subWeeks(7);
        $seriesFrom = $week->copy()->utc();
        $rows = self::orders($store, $seriesFrom, $end)
            ->where(fn (Builder $w) => $w->whereNotNull('o.coupon_id')->orWhereExists(self::conversion())->orWhereExists(self::recovery()))
            ->selectRaw('o.placed_at, o.total_amount, case when exists (select 1 from campaign_conversions cc where cc.order_id = o.id) then 1 else 0 end as is_campaign, case when exists (select 1 from automation_conversions ac where ac.order_id = o.id) then 1 else 0 end as is_recovery')
            ->get();
        $series = [];
        for ($i = 0; $i < 8; $i++) {
            $series[$week->format('Y-m-d')] = ['week_start' => $week->format('Y-m-d'), 'coupons_amount' => 0, 'campaigns_amount' => 0, 'recovery_amount' => 0];
            $week->addWeek();
        }
        foreach ($rows as $row) {
            $key = Carbon::parse($row->placed_at, 'UTC')->setTimezone($tz)->startOfWeek(CarbonInterface::MONDAY)->format('Y-m-d');
            if (isset($series[$key])) {
                $bucket = match (true) {
                    (int) $row->is_campaign === 1 => 'campaigns_amount',
                    (int) $row->is_recovery === 1 => 'recovery_amount',
                    default => 'coupons_amount',
                };
                $series[$key][$bucket] += (int) $row->total_amount;
            }
        }

        $coupons = Coupon::query()->where('store_id', $store->id)->where('status', 'active')->get()
            ->filter(fn (Coupon $c) => $c->displayStatus() === 'active');
        $stats = CouponPresenter::stats($coupons->pluck('id')->all());
        $active = $coupons->sortByDesc(fn (Coupon $c) => [$stats[$c->id]['revenue_amount'] ?? 0, $c->used_count])->take(4)
            ->map(fn (Coupon $c) => [
                'id' => $c->id, 'code' => $c->code, 'type' => $c->type, 'percent_bps' => $c->percent_bps, 'amount' => $c->amount,
                'ends_at' => UserRef::iso($c->ends_at), 'used_count' => (int) $c->used_count, 'usage_limit' => $c->usage_limit,
                'revenue_amount' => (int) ($stats[$c->id]['revenue_amount'] ?? 0),
            ])->values()->all();

        $recent = Campaign::query()->where('store_id', $store->id)->with(CampaignPresenter::with())
            ->orderByDesc('created_at')->orderByDesc('id')->limit(5)->get();
        $conversions = CampaignPresenter::conversions($store->id, $recent->pluck('id')->all());

        return [
            'range' => $range,
            'kpis' => [
                'revenue_amount' => $revenue,
                'revenue_change_pct' => $previous > 0 ? round(($revenue - $previous) * 100 / $previous, 1) : null,
                'campaign_orders' => $campaignOrders,
                'campaign_orders_share_pct' => $allOrders > 0 ? round($campaignOrders * 100 / $allOrders, 1) : 0.0,
                'messages_sent' => CampaignRecipient::query()->where('store_id', $store->id)->where('status', CampaignRecipient::SENT)
                    ->where('sent_at', '>=', $from)->where('sent_at', '<=', $now)->count(),
                'unsubscribes' => MarketingSuppression::query()->where('store_id', $store->id)->where('source', MarketingSuppression::LINK)
                    ->where('created_at', '>=', $from)->where('created_at', '<=', $now)->count(),
                'carts_recovered' => (clone $recovered)->count(),
                'recovered_revenue_amount' => (int) (clone $recovered)->sum('o.total_amount'),
            ],
            'series' => array_values($series),
            'active_coupons' => $active,
            'recent_campaigns' => $recent->map(fn (Campaign $c) => CampaignPresenter::listItem($c, $store->currency, $conversions))->values()->all(),
            'counts' => [
                'coupons' => Coupon::query()->where('store_id', $store->id)->count(),
                'campaigns' => Campaign::query()->where('store_id', $store->id)->count(),
                'automations' => Automation::query()->where('store_id', $store->id)->where('status', Automation::ON)->count(),
            ],
            'currency' => $store->currency,
        ];
    }

    /** Non-cancelled orders of the store placed in [from, to). */
    private static function orders(Store $store, CarbonInterface $from, CarbonInterface $to): Builder
    {
        return DB::table('orders as o')->where('o.tenant_id', $store->tenant_id)->where('o.store_id', $store->id)
            ->where('o.status', '<>', 'cancelled')->where('o.placed_at', '>=', $from)->where('o.placed_at', '<', $to);
    }

    private static function marketingOrders(Store $store, CarbonInterface $from, CarbonInterface $to): Builder
    {
        return self::orders($store, $from, $to)->where(fn (Builder $w) => $w->whereNotNull('o.coupon_id')->orWhereExists(self::conversion())->orWhereExists(self::recovery()));
    }

    private static function recovery(): \Closure
    {
        return fn (Builder $q) => $q->selectRaw('1')->from('automation_conversions as ac')->whereColumn('ac.order_id', 'o.id');
    }

    private static function conversion(): \Closure
    {
        return fn (Builder $q) => $q->selectRaw('1')->from('campaign_conversions as cc')->whereColumn('cc.order_id', 'o.id');
    }
}
