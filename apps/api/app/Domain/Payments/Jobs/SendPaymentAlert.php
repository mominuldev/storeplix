<?php

declare(strict_types=1);

namespace App\Domain\Payments\Jobs;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\SendOrderMail;
use App\Domain\Payments\Mail\PaymentAlertMail;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * Merchant emails of P5B-28: payment mismatch, late payment refunded, gateway refund failed. One email per
 * (payment, kind) (a 30-day cache marker makes retries and replays no-ops). Logs carry ids only.
 */
class SendPaymentAlert implements ShouldQueue
{
    use Queueable, TenantAware;

    public const MISMATCH = 'mismatch';

    public const LATE_REFUND = 'late_refund';

    public const REFUND_FAILED = 'refund_failed';

    public int $tries = 3;

    public function __construct(
        public readonly string $orderId,
        public readonly string $kind,
        public readonly string $paymentId,
        public readonly ?string $refundStatus = null,
    ) {}

    public function handle(TenantCache $cache): void
    {
        $order = Order::query()->find($this->orderId);
        $payment = Payment::query()->find($this->paymentId);
        if ($order === null || $payment === null) {
            return;
        }
        $marker = "payment-alert:{$this->kind}:{$payment->id}";
        if ($cache->get($marker) !== null) {
            return;
        }
        $store = Store::query()->findOrFail($order->store_id);
        $to = SendOrderMail::merchantRecipient($store, StoreSetting::query()->where('store_id', $store->id)->first());
        if ($to === null) {
            Log::info('payments.alert_skipped', ['order_id' => $order->id, 'kind' => $this->kind]);

            return;
        }
        Mail::to($to)->send(new PaymentAlertMail($this->kind, $order, $payment, $store, $this->refundStatus));
        $cache->put($marker, true, now()->addDays(30));
    }
}
