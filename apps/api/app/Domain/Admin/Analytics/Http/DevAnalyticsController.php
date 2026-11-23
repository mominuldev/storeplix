<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics\Http;

use App\Domain\Admin\Analytics\AnalyticsDays;
use App\Domain\Admin\Analytics\Console\AggregateAnalytics;
use App\Domain\Admin\Analytics\MetricsAggregator;
use App\Domain\Admin\Analytics\TenantMetrics;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * TESTING-ONLY `POST /api/v1/dev/analytics/aggregate {from?, to?}` (PHASE-8-2 §4.3; not in openapi). Registered only
 * with APP_ENV local/testing; admin-surface super-admin session. Runs `analytics:aggregate` for the days synchronously
 * (default: today, whose stocks are recomputed on every run; closed days keep P82-5). Used by Playwright.
 */
class DevAnalyticsController
{
    public function __invoke(Request $request, MetricsAggregator $aggregator): JsonResponse
    {
        if (! app()->environment(['local', 'testing'])) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if ($request->user()?->platform_role !== PlatformRole::SuperAdmin->value) {
            throw new ApiException(403, 'forbidden', 'This action is not available in this session.');
        }
        $input = $request->validate([
            'from' => ['sometimes', 'nullable', 'date_format:Y-m-d'],
            'to' => ['sometimes', 'nullable', 'date_format:Y-m-d'],
        ]);
        $today = AnalyticsDays::today();
        $from = (string) ($input['from'] ?? $input['to'] ?? $today);
        $to = (string) ($input['to'] ?? ($input['from'] ?? null ? $from : $today));
        if ($from > $to || AnalyticsDays::diff($from, $to) > 31 || ! AggregateAnalytics::isDay($from)) {
            throw ValidationException::withMessages(['from' => ['from must be on or before to, at most 31 days apart.']]);
        }

        $days = [];
        for ($day = $from; $day <= $to; $day = AnalyticsDays::add($day, 1)) {
            try {
                $aggregator->runDay($day);
            } catch (\InvalidArgumentException $e) {
                throw ValidationException::withMessages(['from' => [$e->getMessage()]]);
            }
            $days[] = $day;
        }

        return new JsonResponse(['data' => ['days' => $days, 'as_of' => TenantMetrics::asOf()]], 200, ['Cache-Control' => 'private, no-store']);
    }
}
