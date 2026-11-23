<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\Http\Requests\BillingQuoteRequest;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Billing\Http\Resources\PlanPresenter;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/** §6.1 quote (O A), change-plan and scheduled-change (O only, Q88). */
class BillingChangeController
{
    public function __construct(private readonly PlanChangeService $plans) {}

    public function quote(Request $request): JsonResponse
    {
        Gate::authorize('billing.view');
        $input = app(BillingQuoteRequest::class)->validated();

        return self::json(['data' => BillingPresenter::quote($this->plans->quote((string) $input['plan_code'], (string) $input['interval']))]);
    }

    public function change(Request $request): JsonResponse
    {
        Gate::authorize('billing.manage');
        $key = self::idempotencyKey($request);
        $input = app(BillingQuoteRequest::class)->validated();
        $result = $this->plans->change((string) $input['plan_code'], (string) $input['interval'], $key, $request->user());

        return self::json(['data' => BillingPresenter::changeResult($result['subscription'], $result['invoice'])], $result['status']);
    }

    public function cancelScheduled(Request $request): JsonResponse
    {
        Gate::authorize('billing.manage');

        return self::json(['data' => PlanPresenter::subscription($this->plans->cancelScheduled($request->user()))]);
    }

    /** Idempotency-Key is required on change-plan and pay (S61); the key is stored on the invoice / payment row. */
    public static function idempotencyKey(Request $request): string
    {
        $key = (string) $request->header(IdempotencyGuard::HEADER, '');
        if (preg_match('/^[A-Za-z0-9_-]{8,64}$/', $key) !== 1) {
            throw new ApiException(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8–64 letters, digits, dashes or underscores).');
        }

        return $key;
    }

    /** @param array<string, mixed> $body */
    public static function json(array $body, int $status = 200): JsonResponse
    {
        return new JsonResponse($body, $status, ['Cache-Control' => 'private, no-store']);
    }
}
