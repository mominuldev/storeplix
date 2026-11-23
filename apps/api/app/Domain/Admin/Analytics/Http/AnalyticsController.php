<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics\Http;

use App\Domain\Admin\Analytics\AnalyticsData;
use App\Domain\Admin\Analytics\AnalyticsDays;
use App\Domain\Admin\Analytics\AnalyticsReports;
use App\Domain\Admin\Analytics\AnalyticsWindow;
use App\Domain\Admin\Analytics\Http\Requests\AnalyticsQueryRequest;
use App\Domain\Admin\Analytics\TenantMetrics;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use Illuminate\Http\JsonResponse;

/**
 * PHASE-8-2 §6.1: `GET /admin/analytics/overview`, `GET /admin/analytics/revenue` (`view_analytics`) and
 * `GET /admin/tenants/{tenant}/metrics` (`view_merchants`), read from the snapshot tables on the admin connection.
 * No data yet → 200 with null metrics (P82-19).
 */
class AnalyticsController
{
    public function overview(AnalyticsQueryRequest $request): JsonResponse
    {
        return $this->respond('overview', $request, '30d', fn (AnalyticsWindow $w, ?string $asOf) => AnalyticsReports::overview($w, $asOf));
    }

    public function revenue(AnalyticsQueryRequest $request): JsonResponse
    {
        return $this->respond('revenue', $request, '12m', fn (AnalyticsWindow $w, ?string $asOf) => AnalyticsReports::revenue($w, $asOf));
    }

    public function tenant(string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id; // 404 not_found

        return AnalyticsData::read(function () use ($tenantId) {
            $state = AnalyticsData::state();
            $anchor = $state['as_of'] ?? AnalyticsDays::add(AnalyticsDays::today(), -1);
            $window = [
                'range' => '30d', 'granularity' => 'day', 'from' => AnalyticsDays::add($anchor, -29), 'to' => $anchor,
                'previous_from' => AnalyticsDays::add($anchor, -59), 'previous_to' => AnalyticsDays::add($anchor, -30),
            ];
            $data = AnalyticsData::cached('tenant', ['tenant' => $tenantId], $state, fn () => TenantMetrics::detail($tenantId, $state['as_of'], $anchor));

            return AdminPresenter::json(['data' => $data, 'meta' => AnalyticsData::meta($state) + $window]);
        });
    }

    /** @param callable(AnalyticsWindow, string|null): array<string, mixed> $build */
    private function respond(string $endpoint, AnalyticsQueryRequest $request, string $defaultRange, callable $build): JsonResponse
    {
        $input = $request->window();

        return AnalyticsData::read(function () use ($endpoint, $input, $defaultRange, $build) {
            $state = AnalyticsData::state();
            $window = AnalyticsWindow::resolve($input, $state['as_of'], $defaultRange); // 422 validation_failed
            $data = AnalyticsData::cached($endpoint, $window->meta(), $state, fn () => $build($window, $state['as_of']));

            return AdminPresenter::json(['data' => $data, 'meta' => AnalyticsData::meta($state) + $window->meta()]);
        });
    }
}
