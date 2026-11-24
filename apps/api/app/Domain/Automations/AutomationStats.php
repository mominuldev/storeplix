<?php

declare(strict_types=1);

namespace App\Domain\Automations;

use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Billing\FeatureGate;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonInterface;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Read models for the automations pages (PHASE-8-6 §7, §9.1, C6): list KPIs, per-automation 7-day counts, the recovery
 * page stats. Revenue = `total_amount` of non-cancelled orders (read time). Ratios are null when the divisor is 0.
 */
final class AutomationStats
{
    /** @return array<string, mixed> AutomationKpis */
    public static function kpis(Store $store): array
    {
        $since7 = now()->subDays(7);
        $runs = AutomationRun::query()->where('store_id', $store->id)->where('created_at', '>=', $since7)
            ->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status')->map(fn ($n) => (int) $n);
        $total = (int) $runs->sum();
        $nonSkipped = $total - (int) ($runs[AutomationRun::SKIPPED] ?? 0);
        $statuses = Automation::query()->where('store_id', $store->id)->pluck('status');
        $conv = self::conversions($store, now()->subDays(30), now()->addSecond());

        return [
            'active' => $statuses->filter(fn ($s) => $s === Automation::ON)->count(),
            'drafts' => $statuses->filter(fn ($s) => $s === Automation::DRAFT)->count(),
            'total' => $statuses->count(),
            'runs_7d' => $total,
            'runs_7d_succeeded_pct' => $nonSkipped > 0 ? round((int) ($runs[AutomationRun::COMPLETED] ?? 0) * 100 / $nonSkipped, 1) : null,
            'messages_sent_month' => self::messagesSince($store, FeatureGate::monthStart()),
            'carts_recovered_30d' => (int) $conv->count(),
            'recovered_revenue_30d' => (int) $conv->sum('o.total_amount'),
        ];
    }

    /** @param list<string> $automationIds @return array<string, int> runs in the last 7 days per automation */
    public static function runs7d(array $automationIds): array
    {
        if ($automationIds === []) {
            return [];
        }

        return AutomationRun::query()->whereIn('automation_id', $automationIds)->where('created_at', '>=', now()->subDays(7))
            ->groupBy('automation_id')->selectRaw('automation_id, count(*) as n')->pluck('n', 'automation_id')->map(fn ($n) => (int) $n)->all();
    }

    /** @return array{runs: int, completed: int, skipped: int, stopped: int, failed: int} */
    public static function stats7d(Automation $automation): array
    {
        $rows = AutomationRun::query()->where('automation_id', $automation->id)->where('created_at', '>=', now()->subDays(7))
            ->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status')->map(fn ($n) => (int) $n);

        return [
            'runs' => (int) $rows->sum(),
            'completed' => (int) ($rows[AutomationRun::COMPLETED] ?? 0),
            'skipped' => (int) ($rows[AutomationRun::SKIPPED] ?? 0),
            'stopped' => (int) ($rows[AutomationRun::STOPPED] ?? 0),
            'failed' => (int) ($rows[AutomationRun::FAILED] ?? 0),
        ];
    }

    /** GET …/stats (C6). @return array<string, mixed> AutomationStats */
    public static function stats(Store $store, Automation $automation, int $days): array
    {
        $tz = (string) ($store->timezone ?: 'Asia/Dhaka');
        $from = Carbon::now($tz)->startOfDay()->subDays($days - 1)->utc();
        $end = now()->addSecond();
        $flow = $automation->recipeDefinition()->flow((array) $automation->settings);

        $steps = [];
        foreach ($flow as $step) {
            if ($step['kind'] !== 'send_message') {
                continue;
            }
            $index = (int) $step['index'];
            $sent = AutomationRunStep::query()->join('automation_runs as r', 'r.id', '=', 'automation_run_steps.run_id')
                ->where('r.automation_id', $automation->id)->where('automation_run_steps.step_index', $index)
                ->where('automation_run_steps.action', AutomationRunStep::SEND_MESSAGE)
                ->where('automation_run_steps.status', AutomationRunStep::DONE)->where('automation_run_steps.executed_at', '>=', $from)->count();
            $conv = self::conversions($store, $from, $end, $automation->id)
                ->join('automation_run_steps as s', 's.id', '=', 'ac.step_id')->where('s.step_index', $index);
            $steps[] = ['step' => $index, 'sent' => $sent, 'recovered' => (int) (clone $conv)->count(), 'revenue_amount' => (int) (clone $conv)->sum('o.total_amount')];
        }

        $daily = [];
        $cursor = Carbon::now($tz)->startOfDay()->subDays($days - 1);
        for ($i = 0; $i < $days; $i++) {
            $daily[$cursor->format('Y-m-d')] = ['date' => $cursor->format('Y-m-d'), 'recovered' => 0, 'revenue_amount' => 0];
            $cursor->addDay();
        }
        foreach (self::conversions($store, $from, $end, $automation->id)->get(['ac.placed_at', 'o.total_amount']) as $row) {
            $key = Carbon::parse($row->placed_at, 'UTC')->setTimezone($tz)->format('Y-m-d');
            if (isset($daily[$key])) {
                $daily[$key]['recovered']++;
                $daily[$key]['revenue_amount'] += (int) $row->total_amount;
            }
        }

        $since30 = now()->subDays(30);
        $runs = AutomationRun::query()->where('automation_id', $automation->id)->where('created_at', '>=', $since30)->get(['id', 'context']);
        $worth = (int) $runs->sum(fn (AutomationRun $r) => (int) ($r->context['cart_total_amount'] ?? $r->context['order_total_amount'] ?? 0));
        $messaged = $runs->isEmpty() ? 0 : AutomationRunStep::query()->whereIn('run_id', $runs->pluck('id')->all())
            ->where('action', AutomationRunStep::SEND_MESSAGE)->where('status', AutomationRunStep::DONE)->distinct()->count('run_id');
        $conv30 = self::conversions($store, $since30, $end, $automation->id);
        $recovered = (int) (clone $conv30)->count();
        $revenue = (int) (clone $conv30)->sum('o.total_amount');

        return [
            'days' => $days,
            'steps' => $steps,
            'daily' => array_values($daily),
            'kpis' => [
                'carts_left_behind' => $runs->count(),
                'carts_left_behind_amount' => $worth,
                'recovered' => $recovered,
                'recovery_rate_pct' => $messaged > 0 ? round($recovered * 100 / $messaged, 1) : null,
                'revenue_amount' => $revenue,
                'average_recovered_amount' => $recovered > 0 ? intdiv($revenue, $recovered) : null,
                'messages_sent_month' => self::messagesSince($store, FeatureGate::monthStart(), $automation->id),
            ],
            'currency' => $store->currency,
        ];
    }

    /** Message steps `done` since `$since` (optionally of one automation). */
    public static function messagesSince(Store $store, CarbonInterface $since, ?string $automationId = null): int
    {
        $q = AutomationRunStep::query()->where('automation_run_steps.store_id', $store->id)
            ->where('automation_run_steps.action', AutomationRunStep::SEND_MESSAGE)->where('automation_run_steps.status', AutomationRunStep::DONE)
            ->where('automation_run_steps.executed_at', '>=', $since);
        if ($automationId !== null) {
            $q->join('automation_runs as r', 'r.id', '=', 'automation_run_steps.run_id')->where('r.automation_id', $automationId);
        }

        return $q->count();
    }

    /** Conversions of non-cancelled orders placed in [from, to) (joined to orders as `o`). */
    public static function conversions(Store $store, CarbonInterface $from, CarbonInterface $to, ?string $automationId = null): Builder
    {
        return DB::table('automation_conversions as ac')
            ->join('orders as o', 'o.id', '=', 'ac.order_id')
            ->where('ac.tenant_id', $store->tenant_id)->where('ac.store_id', $store->id)
            ->where('o.status', '<>', 'cancelled')
            ->where('ac.placed_at', '>=', $from)->where('ac.placed_at', '<', $to)
            ->when($automationId !== null, fn (Builder $q) => $q->where('ac.automation_id', $automationId));
    }
}
