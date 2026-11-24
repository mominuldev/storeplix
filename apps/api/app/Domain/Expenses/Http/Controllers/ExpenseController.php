<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Expenses\ExpenseCategory;
use App\Domain\Expenses\ExpenseCsv;
use App\Domain\Expenses\ExpenseService;
use App\Domain\Expenses\ExpenseSummary;
use App\Domain\Expenses\Http\Requests\StoreExpenseRequest;
use App\Domain\Expenses\Http\Requests\UpdateExpenseRequest;
use App\Domain\Expenses\Http\Resources\ExpensePresenter;
use App\Domain\Expenses\Models\Expense;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-7 §8.1 `/stores/{store}/expenses…` (perm:expenses.manage on every route; no plan gate, P87-6). `{expense}`
 * resolves inside the store and the tenant: another store's or tenant's id → 404 `not_found` (S141).
 */
class ExpenseController
{
    public const PER_PAGE = 50;

    public function __construct(
        private readonly ExpenseService $expenses,
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $categories = implode('|', ExpenseCategory::values());
        $input = $request->validate([
            'filter' => ['sometimes', 'array:month,category'],
            'filter.month' => ['sometimes', 'string', ...self::monthRules($store)],
            'filter.category' => ['sometimes', 'string', "regex:/^({$categories})(,({$categories}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        [$from, $to] = self::monthBounds($store, $input['filter']['month'] ?? null);

        $page = Expense::query()->where('store_id', $store->id)->whereBetween('spent_on', [$from, $to])
            ->when(isset($input['filter']['category']), fn ($q) => $q->whereIn('category', explode(',', $input['filter']['category'])))
            ->orderByDesc('spent_on')->orderByDesc('id')
            ->cursorPaginate(self::PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => ExpensePresenter::many(collect($page->items())),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ]);
    }

    public function summary(Request $request, Store $store, ExpenseSummary $summary): JsonResponse
    {
        $input = $request->validate(['month' => ['sometimes', 'string', ...self::monthRules($store)]]);
        // P87-5: the profit tile needs reports.view + costs.view + plan profit_reports; otherwise null (never 403/402).
        $withProfit = $this->context->allows(Permission::ReportsView) && $this->context->allows(Permission::CostsView)
            && FeatureGate::allows($this->context->tenant(), Feature::ProfitReports);

        return new JsonResponse(['data' => $summary->build($store, $input['month'] ?? null, $withProfit)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(StoreExpenseRequest $request, Store $store): JsonResponse
    {
        $expense = $this->expenses->create($store, $request->validated(), $request->user());

        return new JsonResponse(['data' => ExpensePresenter::expense($expense->refresh())], 201);
    }

    public function show(Store $store, string $expense): JsonResponse
    {
        return new JsonResponse(['data' => ExpensePresenter::expense(self::find($store, $expense))]);
    }

    public function update(UpdateExpenseRequest $request, Store $store, string $expense): JsonResponse
    {
        $row = $this->expenses->update($store, self::find($store, $expense), $request->validated(), $request->user());

        return new JsonResponse(['data' => ExpensePresenter::expense($row->refresh())]);
    }

    public function destroy(Store $store, string $expense): Response
    {
        $this->expenses->delete($store, self::find($store, $expense));

        return response()->noContent();
    }

    /** P87-14: synchronous CSV of one month (envelope exception; errors stay JSON). Readable under impersonation (audited). */
    public function export(Request $request, Store $store): Response
    {
        $input = $request->validate(['month' => ['sometimes', 'string', ...self::monthRules($store)]]);
        [$from, $to, $month] = self::monthBounds($store, $input['month'] ?? null);
        $query = Expense::query()->where('store_id', $store->id)->whereBetween('spent_on', [$from, $to]);
        $count = (clone $query)->count();
        if ($count > ExpenseCsv::MAX_ROWS) {
            throw new ApiException(422, 'export_too_large', 'This month has more than '.ExpenseCsv::MAX_ROWS.' expenses to export.', ['limit' => ExpenseCsv::MAX_ROWS]);
        }
        $csv = ExpenseCsv::render($query->orderByDesc('spent_on')->orderByDesc('id')->get());
        $this->audit->log('expense.exported', $store, ['month' => $month, 'count' => $count]);

        return new Response($csv, 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => "attachment; filename=\"expenses-{$store->slug}-{$month}.csv\"",
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public static function find(Store $store, string $id): Expense
    {
        $row = Expense::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first();
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $row;
    }

    /** §8.3: `YYYY-MM`, 2020-01 … the current month (store tz). @return list<string> */
    private static function monthRules(Store $store): array
    {
        $current = CarbonImmutable::now($store->timezone ?: 'Asia/Dhaka')->format('Y-m');

        return ['regex:/^\d{4}-(0[1-9]|1[0-2])$/', function (string $attribute, mixed $value, \Closure $fail) use ($current) {
            if (is_string($value) && preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $value) === 1 && ($value < '2020-01' || $value > $current)) {
                $fail('The month must be between 2020-01 and the current month.');
            }
        }];
    }

    /** @return array{0: string, 1: string, 2: string} first day, last day, `YYYY-MM` */
    private static function monthBounds(Store $store, ?string $month): array
    {
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $first = $month !== null ? CarbonImmutable::createFromFormat('!Y-m', $month, $tz) : CarbonImmutable::now($tz)->startOfMonth();

        return [$first->format('Y-m-d'), $first->endOfMonth()->format('Y-m-d'), $first->format('Y-m')];
    }
}
