<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\FraudGuard;
use App\Domain\FraudGuard\FraudGuardPresenter;
use App\Domain\FraudGuard\Http\Requests\BlockNumberRequest;
use App\Domain\FraudGuard\Models\BlockedPhone;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-8 §6.2 blocklist (perm:fraud.manage). Blocking cancels nothing: the response says how many open orders
 * that phone has. `phone` is shown only with `customers.view` (`phone_masked` always). Unblock keeps the row.
 */
class BlockedNumberController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'q' => ['sometimes', 'nullable', 'string', 'max:20', 'regex:/^[\d+\s-]*$/'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $digits = preg_replace('/\D/', '', (string) ($input['q'] ?? '')) ?? '';
        $page = BlockedPhone::query()->where('store_id', $store->id)->active()
            ->when($digits !== '', fn ($q) => $q->where('phone', 'like', '%'.ltrim($digits, '0')))
            ->with(['customer', 'creator'])->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);
        $show = $this->context->allows(Permission::CustomersView);

        return new JsonResponse([
            'data' => collect($page->items())->map(fn (BlockedPhone $b) => FraudGuardPresenter::blocked($b, $show))->values()->all(),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ]);
    }

    public function store(Store $store): JsonResponse
    {
        FeatureGate::assertAllows($this->context->tenant(), Feature::FakeOrderGuard);
        $request = app(BlockNumberRequest::class);
        $input = $request->validated();
        $phone = (string) Phone::bdMsisdn($input['phone']);
        $row = DB::transaction(function () use ($store, $phone, $input, $request) {
            if (BlockedPhone::query()->where('store_id', $store->id)->where('phone', $phone)->active()->exists()) {
                throw self::alreadyBlocked();
            }
            $row = new BlockedPhone;
            $row->store_id = $store->id;
            $row->phone = $phone;
            $row->customer_id = Customer::query()->where('store_id', $store->id)->where('phone', $phone)->value('id');
            $row->reason = BlockedPhone::MANUAL;
            $row->note = $input['note'] ?? null;
            $row->source = BlockedPhone::STAFF;
            $row->created_by = $request->user()?->getKey();
            try {
                DB::transaction(fn () => $row->save());
            } catch (UniqueConstraintViolationException) {
                throw self::alreadyBlocked();
            }

            return $row;
        });
        $this->audit->log('fraud.number_blocked', $store, ['phone_masked' => FraudGuard::mask($phone), 'blocked_id' => $row->id]);
        $open = Order::query()->where('store_id', $store->id)->where('customer_phone', $phone)
            ->whereIn('status', [Order::PENDING_PAYMENT, Order::PENDING, Order::CONFIRMED, Order::READY_TO_SHIP])->count();

        return new JsonResponse(['data' => FraudGuardPresenter::blocked($row->refresh(), $this->context->allows(Permission::CustomersView)) + ['open_orders_count' => $open]], 201);
    }

    public function destroy(Request $request, Store $store, string $entry): Response
    {
        $row = BlockedPhone::query()->where('store_id', $store->id)->whereKey(strtolower($entry))->active()->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        $row->unblocked_at = now();
        $row->unblocked_by = $request->user()?->getKey();
        $row->save();
        $this->audit->log('fraud.number_unblocked', $store, ['phone_masked' => FraudGuard::mask($row->phone), 'blocked_id' => $row->id, 'reason' => $row->reason]);

        return response()->noContent();
    }

    private static function alreadyBlocked(): ApiException
    {
        return new ApiException(409, 'already_blocked', 'This number is already blocked.');
    }
}
