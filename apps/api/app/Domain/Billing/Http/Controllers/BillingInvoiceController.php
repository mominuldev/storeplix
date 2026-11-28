<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Billing\BillingInvoicePdf;
use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Gateways\PlatformCredentials;
use App\Domain\Billing\Http\Requests\PayInvoiceRequest;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;

/** §6.1 invoices (O A read; pay O only) and payment status. Another tenant's id → 404 (BelongsToTenant + RLS). */
class BillingInvoiceController
{
    public function __construct(private readonly BillingPaymentService $payments) {}

    public function index(Request $request): JsonResponse
    {
        Gate::authorize('billing.view');
        $request->validate([
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:50'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'filter.status' => ['sometimes', 'string', 'in:'.implode(',', BillingInvoice::STATUSES)],
            // PHASE-8-9A §5.3: comma list of BillingInvoiceKind (SMS credit purchase history).
            'filter.kind' => ['sometimes', 'string', 'regex:/^('.implode('|', BillingInvoice::KINDS).')(,('.implode('|', BillingInvoice::KINDS).'))*$/'],
        ]);
        $query = BillingInvoice::query()->orderByDesc('issued_at')->orderByDesc('id');
        if (is_string($status = $request->input('filter.status'))) {
            $query->where('status', $status);
        }
        if (is_string($kind = $request->input('filter.kind'))) {
            $query->whereIn('kind', array_unique(explode(',', $kind)));
        }
        $page = $query->paginate((int) $request->input('per_page', 20));

        return BillingChangeController::json([
            'data' => collect($page->items())->map(fn (BillingInvoice $i) => BillingPresenter::invoiceSummary($i))->all(),
            'meta' => [
                'current_page' => $page->currentPage(), 'per_page' => $page->perPage(), 'total' => $page->total(), 'last_page' => $page->lastPage(),
                'providers' => PlatformCredentials::providers(),
            ],
        ]);
    }

    public function show(string $invoice): JsonResponse
    {
        Gate::authorize('billing.view');

        return BillingChangeController::json(['data' => BillingPresenter::invoice(self::find($invoice))]);
    }

    public function pdf(string $invoice, BillingInvoicePdf $pdf): Response
    {
        Gate::authorize('billing.view');
        $row = self::find($invoice);
        $file = $pdf->get($row);

        return new Response($file['bytes'], 200, [
            'Content-Type' => $file['mime'],
            'Content-Disposition' => 'attachment; filename="'.$row->number.'.'.$file['extension'].'"',
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public function pay(Request $request, string $invoice): JsonResponse
    {
        Gate::authorize('billing.manage');
        $key = BillingChangeController::idempotencyKey($request);
        $row = self::find($invoice);
        $input = app(PayInvoiceRequest::class)->validated();

        $limiterKey = 'billing-pay:'.$row->tenant_id;
        if (RateLimiter::tooManyAttempts($limiterKey, 10)) {
            throw new ApiException(429, 'rate_limited', 'Too many payment attempts. Try again in a minute.', retryAfter: RateLimiter::availableIn($limiterKey));
        }
        RateLimiter::hit($limiterKey, 60);

        $payment = $this->payments->pay($row, (string) $input['provider'], $key, $request->user());

        return BillingChangeController::json(['data' => BillingPresenter::payment($payment)], 201);
    }

    public function payment(string $payment): JsonResponse
    {
        Gate::authorize('billing.view');
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $payment) === 1 ? BillingPayment::query()->find(strtolower($payment)) : null;
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        // PHASE-8-1 P8-10 (S71): no provider query in a read-only impersonation session; answered from the database.
        if ($row->status === BillingPayment::PENDING && $row->provider !== BillingPayment::MANUAL
            && ! ImpersonationSession::isImpersonating(request())
            && ($row->last_queried_at ?? $row->created_at)->lessThanOrEqualTo(now()->subSeconds(10))) {
            $row = $this->payments->refresh($row);
        }

        return BillingChangeController::json(['data' => BillingPresenter::payment($row)]);
    }

    private static function find(string $id): BillingInvoice
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? BillingInvoice::query()->find(strtolower($id)) : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
