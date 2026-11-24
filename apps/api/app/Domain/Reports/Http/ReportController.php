<?php

declare(strict_types=1);

namespace App\Domain\Reports\Http;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Expenses\ExpenseRevision;
use App\Domain\Reports\DeliveryReport;
use App\Domain\Reports\Http\Requests\ReportRangeRequest;
use App\Domain\Reports\ProfitReport;
use App\Domain\Reports\ReportRange;
use App\Domain\Reports\SalesReport;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

/**
 * Reports (PHASE-7-CONTRACT §6.3, P7-18/P7-19): live aggregates in the store timezone, cached per tenant 120 s.
 * Sales and Delivery: every role. Profit: ViewCosts (403) and feature `profit_reports` (402).
 */
final class ReportController
{
    public const CACHE_SECONDS = 120;

    private const HEADERS = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly TenantContext $context,
        private readonly TenantCache $cache,
        private readonly ExpenseRevision $expenses,
    ) {}

    public function sales(Store $store, ReportRangeRequest $request, SalesReport $report): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->respond('sales', $store, $request, fn (ReportRange $r) => $report->build($store, $r));
    }

    public function profit(Store $store, ReportRangeRequest $request, ProfitReport $report): JsonResponse
    {
        Gate::authorize('view', $store);
        if (! $this->context->allows(Permission::CostsView)) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to see profit.');
        }
        FeatureGate::assertAllows($this->context->tenant(), Feature::ProfitReports);

        return $this->respond('profit', $store, $request, fn (ReportRange $r) => $report->build($store, $r));
    }

    public function delivery(Store $store, ReportRangeRequest $request, DeliveryReport $report): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->respond('delivery', $store, $request, fn (ReportRange $r) => $report->build($store, $r));
    }

    /**
     * PHASE-8-7 P87-12: the profit key carries the store's `expenses_rev` token ('0' when none), so an expense write is
     * in the next Profit & loss response; sales and delivery keys are unchanged.
     */
    public static function cacheKey(string $type, string $hash, ?string $expensesRev = null): string
    {
        return "reports:{$type}:{$hash}".($expensesRev !== null ? ":{$expensesRev}" : '');
    }

    /** @param Closure(ReportRange): array<string, mixed> $build */
    private function respond(string $type, Store $store, ReportRangeRequest $request, Closure $build): JsonResponse
    {
        $validated = $request->validated();
        $range = ReportRange::resolve($validated['from'] ?? null, $validated['to'] ?? null, $store->timezone ?: 'Asia/Dhaka');

        $payload = $this->cache->remember(self::cacheKey($type, $range->cacheHash($store->id), $type === 'profit' ? $this->expenses->token($store->id) : null), self::CACHE_SECONDS, fn () => [
            'data' => $build($range),
            'meta' => $range->meta($store->currency ?: 'BDT') + ['generated_at' => now()->toIso8601ZuluString()],
        ]);

        return new JsonResponse($payload, 200, self::HEADERS);
    }
}
