<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\IntegrationLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

/**
 * TESTING-ONLY time travel for the expiry e2e (PHASE-5B §13 QA "online-checkout"). Registered only when
 * PAYMENTS_FAKE=true and the environment is not production (routes/api.php). Moves the hold (or the link expiry) of
 * the payment's order into the past and runs the same expiry as `payments:expire` / `payment-links:expire`.
 */
class DevPaymentController
{
    public function expireNow(string $payment, IntegrationLookup $lookup, TenantContext $context, PaymentService $payments, PaymentLinkService $links): JsonResponse
    {
        abort_if(app()->environment('production') || ! config('payments.fake'), 404);
        $owner = $lookup->paymentOwner($payment) ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        return $context->run($owner['tenant_id'], function () use ($payment, $payments, $links) {
            $row = Payment::query()->whereKey(strtolower($payment))->firstOrFail();
            $order = Order::query()->findOrFail($row->order_id);
            $past = now()->subMinute();
            if ($row->purpose === Payment::PURPOSE_LINK && $row->payment_link_id !== null) {
                DB::table('payment_links')->where('id', $row->payment_link_id)->where('status', PaymentLink::ACTIVE)->update(['expires_at' => $past, 'updated_at' => now()]);
                $links->expire(PaymentLink::query()->findOrFail($row->payment_link_id));
            } else {
                if ($order->status === Order::PENDING_PAYMENT) {
                    DB::table('orders')->where('id', $order->id)->update(['payment_expires_at' => $past, 'updated_at' => now()]);
                    DB::table('payments')->where('id', $row->id)->where('status', 'pending')->update(['expires_at' => $past, 'updated_at' => now()]);
                }
                $payments->expireOrder($order->refresh());
            }
            $order->refresh();

            return new JsonResponse(['data' => [
                'order_status' => $order->status,
                'cancel_reason' => $order->cancel_reason,
                'payment_status' => (string) Payment::query()->whereKey($row->id)->value('status'),
            ]]);
        });
    }
}
