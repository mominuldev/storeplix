<?php

declare(strict_types=1);

namespace App\Domain\Admin\Invoices\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\Http\Requests\AdminMarkPaidRequest;
use App\Domain\Admin\Tenants\Http\Requests\AdminWriteRequest;
use App\Domain\Billing\BillingInvoicePdf;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Ops\MarkInvoicePaid;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Billing\Ops\ResendInvoice;
use App\Domain\Billing\Ops\VoidInvoice;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\Rule;

/** PHASE-8-1 §6.3 invoices: reads on the admin connection (P8-6), writes as the tenant through the Billing Actions (P8-7). */
class AdminInvoiceController
{
    public const RESENDS_PER_HOUR = 3;

    public function __construct(private readonly TenantContext $context) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'string', Rule::in(BillingInvoice::STATUSES)],
            'filter.provider' => ['sometimes', 'string', Rule::in([BillingPayment::BKASH, BillingPayment::SSLCOMMERZ, BillingPayment::MANUAL])],
            'filter.q' => ['sometimes', 'nullable', 'string', 'max:120'],
            'filter.from' => ['sometimes', 'date_format:Y-m-d'],
            'filter.to' => ['sometimes', 'date_format:Y-m-d'],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        $query = AdminPresenter::invoiceQuery()->orderByDesc('i.issued_at')->orderByDesc('i.id');
        if (isset($filter['status'])) {
            $query->where('i.status', $filter['status']);
        }
        if (isset($filter['provider'])) {
            $query->where('bp.provider', $filter['provider']);
        }
        if (isset($filter['from'])) {
            $query->where('i.issued_at', '>=', Carbon::parse($filter['from'])->startOfDay());
        }
        if (isset($filter['to'])) {
            $query->where('i.issued_at', '<=', Carbon::parse($filter['to'])->endOfDay());
        }
        if (is_string($q = $filter['q'] ?? null) && ($term = str_replace(['%', '_'], '', mb_strtolower(trim($q)))) !== '') {
            $query->where(fn (Builder $w) => $w->where('i.number', strtoupper($term))->orWhereLike('i.number', "{$term}%")
                ->orWhereExists(fn (Builder $e) => $e->from('stores as s')->whereColumn('s.tenant_id', 'i.tenant_id')
                    ->where(fn (Builder $n) => $n->whereLike('s.name', "%{$term}%")->orWhereLike('s.slug', "{$term}%"))));
        }
        $page = $query->paginate((int) ($input['per_page'] ?? 25));
        $shops = AdminPresenter::shopRefs(collect($page->items())->pluck('tenant_id')->map(fn ($id) => (string) $id)->all());

        return AdminPresenter::paginated($page, collect($page->items())->map(fn ($row) => AdminPresenter::invoiceSummary($row, $shops))->all());
    }

    public function show(string $invoice): JsonResponse
    {
        [$tenantId, $invoiceId] = self::locate($invoice);

        return AdminPresenter::json(['data' => $this->present($tenantId, $invoiceId)]);
    }

    public function pdf(string $invoice, BillingInvoicePdf $pdf): Response
    {
        [$tenantId, $invoiceId] = self::locate($invoice);
        [$row, $file] = $this->context->run($tenantId, function () use ($invoiceId, $pdf) {
            $row = BillingInvoice::query()->findOrFail($invoiceId);

            return [$row, $pdf->get($row)];
        });

        return new Response($file['bytes'], 200, [
            'Content-Type' => $file['mime'],
            'Content-Disposition' => 'attachment; filename="'.$row->number.'.'.$file['extension'].'"',
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    /** P8-15: `provider: manual`, Idempotency-Key required (S61), 409 invoice_not_open when already paid. */
    public function markPaid(AdminMarkPaidRequest $request, string $invoice, MarkInvoicePaid $action): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        [$tenantId, $invoiceId] = self::locate($invoice);
        $action->handle($tenantId, $invoiceId, (string) $request->validated('reference'),
            OpsActor::staff(AdminBillingController::staff($request), $request->reason()), $key);

        return AdminPresenter::json(['data' => $this->present($tenantId, $invoiceId)]);
    }

    public function void(AdminWriteRequest $request, string $invoice, VoidInvoice $action): JsonResponse
    {
        [$tenantId, $invoiceId] = self::locate($invoice);
        $action->handle($tenantId, $invoiceId, OpsActor::staff(AdminBillingController::staff($request), $request->reason()));

        return AdminPresenter::json(['data' => $this->present($tenantId, $invoiceId)]);
    }

    /** P8-15: re-sends the Phase 7 e-mail to the owner; 3 per hour per invoice. No body (openapi 1.9.0). */
    public function resend(Request $request, string $invoice, ResendInvoice $action): JsonResponse
    {
        [$tenantId, $invoiceId] = self::locate($invoice);
        $limiter = 'admin-invoice-resend:'.$invoiceId;
        if (RateLimiter::tooManyAttempts($limiter, self::RESENDS_PER_HOUR)) {
            throw new ApiException(429, 'rate_limited', 'This invoice was sent 3 times in the last hour. Try again later.', retryAfter: RateLimiter::availableIn($limiter));
        }
        $action->handle($tenantId, $invoiceId, OpsActor::staff(AdminBillingController::staff($request), (string) $request->input('reason', 'resend')));
        RateLimiter::hit($limiter, 3600);

        return AdminPresenter::json(['data' => null], 202);
    }

    /** @return array{0: string, 1: string} [tenant id, invoice id]; unknown id → 404 */
    private static function locate(string $invoice): array
    {
        $tenantId = AdminPresenter::invoiceTenant($invoice);

        return $tenantId === null ? throw new ApiException(404, 'not_found', 'Resource not found.') : [$tenantId, strtolower($invoice)];
    }

    /** @return array<string, mixed> AdminInvoice (Phase 7 BillingInvoice + tenant + payments with provider reference) */
    private function present(string $tenantId, string $invoiceId): array
    {
        $data = $this->context->run($tenantId, function () use ($invoiceId) {
            $row = BillingInvoice::query()->findOrFail($invoiceId);
            $data = BillingPresenter::invoice($row);
            $data['payments'] = $row->payments()->orderBy('created_at')->get()->map(fn (BillingPayment $p) => BillingPresenter::payment($p) + [
                'provider_reference' => $p->provider_trx_id ?? $p->reference,
                'is_duplicate' => (bool) $p->is_duplicate,
            ])->all();

            return $data;
        });

        return $data + ['tenant' => AdminPresenter::shopRefs([$tenantId])[$tenantId] ?? ['id' => $tenantId, 'name' => '', 'slug' => '']];
    }
}
