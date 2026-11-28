<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\FraudGuard\FraudGuard;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderService;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\RefundResult;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Jobs\SendPaymentAlert;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Returns\ReturnService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tracking\TrackingHooks;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Online money (PHASE-5B-CONTRACT P5B-14–P5B-25, §5.3). Drivers only REPORT; this service decides:
 * a charge is paid only when the provider reports final success AND the amount equals payments.amount (paisa) AND the
 * currency is BDT AND the echoed reference is our payment id (P5B-16). Anything else is a mismatch: payment `failed`,
 * order untouched, audit `payment.mismatch`, merchant email.
 *
 * Every state change locks the order row first, then the payment row (order → payments → inventories → coupon →
 * counter) and moves the payment with a conditional UPDATE (PaymentStateMachine). No row lock is ever held across a
 * gateway call: charges and refunds are committed first, the provider is called outside any transaction, and the
 * result is applied in a second transaction.
 */
class PaymentService
{
    public const MIN_REFUND = 100; // ৳ 1

    public function __construct(
        private readonly PaymentManager $gateways,
        private readonly OrderService $orders,
        private readonly OrderNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly ReturnService $returns,
    ) {}

    // ------------------------------------------------------------------ accounts

    /** Connected and enabled account of this store for a provider (a checkout payment method, P5B-12). */
    public function usableAccount(string $storeId, ?string $provider): ?PaymentGatewayAccount
    {
        if (! in_array($provider, Payment::ONLINE_PROVIDERS, true)) {
            return null;
        }
        $account = PaymentGatewayAccount::query()->where('store_id', $storeId)->where('provider', $provider)->first();

        return $account !== null && $account->isUsable() ? $account : null;
    }

    /** Enabled gateways in display order (bkash, sslcommerz, nagad). @return list<string> */
    public static function usableProviders(string $storeId): array
    {
        $enabled = PaymentGatewayAccount::query()->where('store_id', $storeId)->where('status', PaymentGatewayAccount::CONNECTED)
            ->where('enabled', true)->pluck('provider')->all();

        return array_values(array_filter(Payment::ONLINE_PROVIDERS, fn (string $p) => in_array($p, $enabled, true)));
    }

    /** P5B-13: the shop requires the delivery charge in advance for this order. */
    public static function advanceRequired(?StoreSetting $settings, int $shippingAmount): bool
    {
        return $settings?->cod_advance === 'delivery_charge' && $shippingAmount > 0;
    }

    // ------------------------------------------------------------------ charges

    /** A pending online charge, inside the caller's transaction (order row locked or just created). */
    public function newCharge(Order $order, PaymentGatewayAccount $account, string $purpose, int $amount, Carbon $expiresAt, ?PaymentLink $link = null): Payment
    {
        $attempt = (int) Payment::query()->where('order_id', $order->id)->where('type', Payment::TYPE_CHARGE)
            ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('purpose', $purpose)->count() + 1;
        $payment = new Payment;
        $payment->store_id = $order->store_id;
        $payment->order_id = $order->id;
        $payment->provider = $account->provider;
        $payment->type = Payment::TYPE_CHARGE;
        $payment->status = Payment::STATUS_PENDING;
        $payment->amount = $amount;
        $payment->currency = 'BDT';
        $payment->purpose = $purpose;
        $payment->gateway_account_id = $account->id;
        $payment->payment_link_id = $link?->id;
        $payment->expires_at = $expiresAt;
        $payment->attempt = min($attempt, 32000);
        $payment->save();

        return $payment;
    }

    /**
     * Starts the hosted payment OUTSIDE any transaction (P5B-15). A gateway error or timeout fails this attempt
     * (`initiation_failed`); the order stays and the shopper retries (POST /storefront/orders/pay).
     *
     * @return array{payment_id: string, provider: string, status: string, redirect_url: string|null, amount: int, expires_at: string|null} PaymentInitiation
     */
    public function initiate(Payment $payment): array
    {
        $account = $payment->gateway_account_id !== null ? PaymentGatewayAccount::query()->find($payment->gateway_account_id) : null;
        try {
            if ($account === null || ! $account->isConnected()) {
                throw new GatewayException(GatewayException::NOT_CONNECTED);
            }
            $ipn = $payment->provider === PaymentGatewayAccount::SSLCOMMERZ ? PaymentUrls::ipnUrl($account) : null;
            $initiation = $this->gateways->driver($payment->provider)->initiate($payment, $account, PaymentUrls::returnUrl($payment), $ipn);
            DB::table('payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->update([
                'provider_payment_id' => $initiation->providerPaymentId !== null ? mb_substr($initiation->providerPaymentId, 0, 128) : null,
                'raw' => json_encode(['initiate' => $initiation->raw]),
                'updated_at' => now(),
            ]);
            $payment->provider_payment_id = $initiation->providerPaymentId;

            return PaymentPresenter::initiation($payment, 'redirect', $initiation->redirectUrl);
        } catch (Throwable $e) {
            if (! $e instanceof GatewayException) {
                report($e);
            }
            Log::warning('payments.initiation_failed', ['payment_id' => $payment->id, 'provider' => $payment->provider, 'code' => $e instanceof GatewayException ? $e->errorCode : 'error']);
            $this->markUnpaid($payment, PaymentStateMachine::FAILED, 'initiation_failed', [], 'initiate');

            return PaymentPresenter::initiation($payment, 'initiation_failed', null);
        }
    }

    // ------------------------------------------------------------------ verification

    /**
     * Browser return (P5B-18). `$outcome` (success|failure|cancel) is a trigger only: success → complete (bKash
     * Execute / SSLCommerz Validation API), on a timeout → query; failure/cancel → query once, then failed/cancelled if
     * the provider doesn't report it paid. A gateway error leaves the charge pending for the reconcile job.
     *
     * @param  array<string, mixed>  $params
     */
    public function handleReturn(Payment $payment, string $outcome, array $params): void
    {
        $payment->refresh();
        $pending = $payment->status === PaymentStateMachine::PENDING;
        // A bKash payment that is no longer pending is never executed (no money moves). SSLCommerz takes the money at
        // the gateway, so a late success is still validated (and then refunded, P5B-21).
        if (! $pending && ! ($payment->provider === PaymentGatewayAccount::SSLCOMMERZ && $outcome === 'success' && $payment->status !== PaymentStateMachine::SUCCEEDED)) {
            return;
        }
        $account = PaymentGatewayAccount::query()->find($payment->gateway_account_id);
        if ($account === null) {
            return;
        }
        $driver = $this->gateways->driver($payment->provider);
        try {
            if ($outcome === 'success') {
                try {
                    $verification = $driver->complete($payment, $account, $params);
                } catch (GatewayException $e) {
                    if ($e->errorCode !== GatewayException::PROVIDER_UNAVAILABLE) {
                        throw $e;
                    }
                    $verification = $driver->query($payment, $account);
                }
            } else {
                $verification = $driver->query($payment, $account);
                if ($verification->status === Verification::PENDING) {
                    $verification = new Verification(
                        $outcome === 'cancel' ? Verification::CANCELLED : Verification::FAILED,
                        null, null, null, null, $outcome === 'cancel' ? 'cancelled' : 'failed', $verification->raw,
                    );
                }
            }
        } catch (GatewayException $e) {
            Log::warning('payments.return_unverified', ['payment_id' => $payment->id, 'code' => $e->errorCode]);

            return;
        }
        $this->apply($payment, $verification, 'return');
    }

    /** Query the provider and apply the answer (reconcile, expiry, retry, IPN triggers). Null on a gateway error. */
    public function verify(Payment $payment): ?Verification
    {
        $account = PaymentGatewayAccount::query()->find($payment->gateway_account_id);
        if ($account === null) {
            return null;
        }
        try {
            $verification = $this->gateways->driver($payment->provider)->query($payment, $account);
        } catch (GatewayException $e) {
            Log::warning('payments.query_failed', ['payment_id' => $payment->id, 'code' => $e->errorCode]);

            return null;
        }
        $this->apply($payment, $verification, 'query');

        return $verification;
    }

    /** P5B-16: the one decision point. Returns the payment's status afterwards. */
    public function apply(Payment $payment, Verification $verification, string $source): string
    {
        if (! $verification->succeeded()) {
            if ($verification->status !== Verification::PENDING) {
                $failed = $verification->status === Verification::CANCELLED ? PaymentStateMachine::CANCELLED : PaymentStateMachine::FAILED;
                $this->markUnpaid($payment, $failed, $verification->failureCode ?? $failed, $verification->raw, $source);
            }

            return (string) Payment::query()->whereKey($payment->id)->value('status');
        }
        $mismatch = self::mismatch($payment, $verification);
        if ($mismatch !== null) {
            $this->markMismatch($payment, $mismatch, $verification, $source);

            return (string) Payment::query()->whereKey($payment->id)->value('status');
        }
        $this->markPaid($payment, $verification, $source);

        return (string) Payment::query()->whereKey($payment->id)->value('status');
    }

    /** null = matches; else the failure code. */
    public static function mismatch(Payment $payment, Verification $v): ?string
    {
        return match (true) {
            $v->amount === null || $v->amount !== (int) $payment->amount => 'amount_mismatch',
            strtoupper((string) $v->currency) !== 'BDT' => 'currency_mismatch',
            $v->reference === null || ! hash_equals(strtolower($payment->id), strtolower(trim($v->reference))) => 'reference_mismatch',
            default => null,
        };
    }

    /** @param array<string, mixed> $raw */
    private function markUnpaid(Payment $payment, string $status, string $code, array $raw, string $source): void
    {
        DB::transaction(function () use ($payment, $status, $code, $raw, $source) {
            $order = $this->lockOrder($payment);
            $columns = ['failure_code' => mb_substr($code, 0, 48)] + ($raw !== [] ? ['raw' => json_encode(['verify' => $raw])] : []);
            if (PaymentStateMachine::move($payment, PaymentStateMachine::PENDING, $status, $columns) && $order !== null) {
                OrderTimeline::record($order, 'payment', null, null, [
                    'payment_id' => $payment->id, 'provider' => $payment->provider, 'purpose' => $payment->purpose,
                    'amount' => $payment->amount, 'status' => $status, 'failure_code' => $code, 'source' => $source,
                ]);
            }
        });
    }

    private function markMismatch(Payment $payment, string $code, Verification $v, string $source): void
    {
        $moved = DB::transaction(function () use ($payment, $code, $v, $source) {
            $order = $this->lockOrder($payment);
            $from = (string) Payment::query()->whereKey($payment->id)->lockForUpdate()->value('status');
            if ($from !== PaymentStateMachine::PENDING) {
                return false;
            }
            PaymentStateMachine::move($payment, PaymentStateMachine::PENDING, PaymentStateMachine::FAILED, [
                'failure_code' => $code, 'raw' => json_encode(['verify' => $v->raw]),
            ]);
            $meta = ['payment_id' => $payment->id, 'provider' => $payment->provider, 'failure_code' => $code, 'expected' => $payment->amount, 'reported' => $v->amount, 'source' => $source];
            if ($order !== null) {
                OrderTimeline::record($order, 'payment', null, 'The payment didn’t match this order and wasn’t accepted.', $meta + ['status' => 'failed', 'amount' => $payment->amount, 'purpose' => $payment->purpose]);
            }
            $this->audit->log('payment.mismatch', $order ?? $payment, $meta, null, null, true);

            return true;
        });
        if ($moved && $payment->order_id !== null) {
            SendPaymentAlert::dispatch($payment->order_id, SendPaymentAlert::MISMATCH, $payment->id)->forTenant($payment->tenant_id)->onQueue(OrderNotifier::QUEUE);
        }
    }

    /** §5.3 step 5: apply a verified success exactly once; anything that can't be applied cleanly is refunded. */
    private function markPaid(Payment $payment, Verification $v, string $source): void
    {
        $after = DB::transaction(function () use ($payment, $v, $source) {
            $order = $this->lockOrder($payment);
            $from = (string) Payment::query()->whereKey($payment->id)->lockForUpdate()->value('status');
            if ($from === PaymentStateMachine::SUCCEEDED) {
                return null;
            }
            try {
                $moved = DB::transaction(fn () => PaymentStateMachine::move($payment, $from, PaymentStateMachine::SUCCEEDED, [
                    'provider_trx_id' => $v->providerTrxId !== null ? mb_substr($v->providerTrxId, 0, 64) : null,
                    'verified_at' => now(),
                    'failure_code' => null,
                    'raw' => json_encode(['verify' => $v->raw]),
                ]));
            } catch (UniqueConstraintViolationException) {
                // One gateway transaction can't pay two charges (P5B-20): the second is a mismatch.
                if ($from === PaymentStateMachine::PENDING) {
                    PaymentStateMachine::move($payment, PaymentStateMachine::PENDING, PaymentStateMachine::FAILED, ['failure_code' => 'duplicate_transaction']);
                }
                $this->audit->log('payment.mismatch', $order ?? $payment, ['payment_id' => $payment->id, 'failure_code' => 'duplicate_transaction', 'source' => $source], null, null, true);

                return null;
            }
            if (! $moved) {
                return null;
            }

            if ($payment->purpose === Payment::PURPOSE_TEST || $order === null) {
                PaymentGatewayAccount::query()->find($payment->gateway_account_id)?->markVerified();

                return ['refund' => $payment->purpose === Payment::PURPOSE_TEST ? 'test' : null];
            }

            $amount = (int) $payment->amount;
            $order->paid_amount += $amount;
            $order->payment_status = self::paymentStatus($order);
            WebhookEvents::orderPaidIfChanged($order);
            $order->revision++;
            $meta = ['payment_id' => $payment->id, 'provider' => $payment->provider, 'purpose' => $payment->purpose, 'amount' => $amount, 'status' => 'succeeded', 'source' => $source];
            $link = $payment->payment_link_id !== null ? PaymentLink::query()->whereKey($payment->payment_link_id)->lockForUpdate()->first() : null;
            $result = ['refund' => null, 'placed' => false, 'confirmed' => false];

            $clean = $from === PaymentStateMachine::PENDING;
            if ($clean && in_array($payment->purpose, [Payment::PURPOSE_ORDER, Payment::PURPOSE_ADVANCE], true) && $order->status === Order::PENDING_PAYMENT) {
                $order->status = Order::CONFIRMED;
                $order->confirmed_at ??= now();
                $order->save();
                OrderTimeline::record($order, 'payment', null, null, $meta);
                OrderTimeline::record($order, 'status_changed', null, null, ['reason' => 'payment_verified', 'payment_id' => $payment->id], Order::PENDING_PAYMENT, Order::CONFIRMED);
                WebhookEvents::orderStatus($order, Order::CONFIRMED);
                $this->syncCodCharge($order);
                $result['placed'] = true;
            } elseif ($clean && $payment->purpose === Payment::PURPOSE_LINK && $link?->status === PaymentLink::ACTIVE
                && in_array($order->status, [Order::PENDING, Order::CONFIRMED, Order::READY_TO_SHIP], true) && $order->paid_amount <= $order->total_amount) {
                $link->status = PaymentLink::PAID;
                $link->paid_at = now();
                $link->save();
                $confirm = $order->status === Order::PENDING;
                app(FraudGuard::class)->linkPaid($order, $link, $confirm); // PHASE-8-8 §5.3: a paid link releases the hold
                if ($confirm) {
                    $order->status = Order::CONFIRMED;
                    $order->confirmed_at ??= now();
                }
                $order->save();
                OrderTimeline::record($order, 'payment', null, null, $meta + ['payment_link_id' => $link->id]);
                OrderTimeline::record($order, 'payment_link', null, null, ['action' => 'paid', 'link_id' => $link->id, 'amount' => $amount, 'provider' => $link->provider]);
                if ($confirm) {
                    OrderTimeline::record($order, 'status_changed', null, null, ['reason' => 'payment_verified', 'payment_id' => $payment->id], Order::PENDING, Order::CONFIRMED);
                    WebhookEvents::orderStatus($order, Order::CONFIRMED);
                    $result['confirmed'] = true;
                }
                $this->syncCodCharge($order);
            } else {
                // P5B-21 late payment (order cancelled, hold/link expired, attempt superseded): never revive the order;
                // book the money, then refund all of it through the gateway.
                $order->save();
                OrderTimeline::record($order, 'payment', null, 'Paid after the payment window closed: refunding it in full.', $meta + ['late' => true]);
                $result['refund'] = 'late';
            }

            return $result;
        });
        if ($after === null) {
            return;
        }
        $order = $payment->order_id !== null ? Order::query()->find($payment->order_id) : null;
        if (($after['placed'] ?? false) && $order !== null) {
            $this->notifier->placed($order, null);
        }
        if (($after['confirmed'] ?? false) && $order !== null) {
            $this->notifier->sms($order, 'order_confirmed', null);
        }
        if (($after['refund'] ?? null) !== null) {
            $refund = $this->autoRefund($payment->refresh(), $after['refund'] === 'test' ? 'Test payment' : 'Paid after the order expired');
            if ($after['refund'] === 'late' && $order !== null) {
                SendPaymentAlert::dispatch($order->id, SendPaymentAlert::LATE_REFUND, $payment->id, $refund?->status)->forTenant($payment->tenant_id)->onQueue(OrderNotifier::QUEUE);
            }
        }
    }

    /** payment_status from paid/refunded totals. */
    public static function paymentStatus(Order $order): string
    {
        return match (true) {
            $order->refunded_amount > 0 && $order->refunded_amount >= $order->paid_amount => 'refunded',
            $order->refunded_amount > 0 => 'partially_refunded',
            $order->total_amount === 0 || $order->paid_amount >= $order->total_amount => 'paid',
            $order->paid_amount > 0 => 'partially_paid',
            default => 'unpaid',
        };
    }

    /** The pending COD charge follows the due amount (online advances and links reduce it). Caller holds the order lock. */
    public function syncCodCharge(Order $order): void
    {
        $due = $order->dueAmount();
        $query = Payment::query()->where('order_id', $order->id)->where('provider', Payment::PROVIDER_COD)->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING);
        $due > 0 ? $query->update(['amount' => $due, 'updated_at' => now()]) : $query->update(['status' => Payment::STATUS_CANCELLED, 'updated_at' => now()]);
    }

    // ------------------------------------------------------------------ expiry (P5B-21)

    /**
     * Ends an unpaid hold: query the provider first (paid → applied, the order confirms); else cancel the charge
     * (`expired`) and the order (`payment_timeout`; stock and coupon released; no SMS). `$force` ignores the hold end
     * (testing-only time travel).
     */
    public function expireOrder(Order $order, bool $force = false): Order
    {
        $order->refresh();
        if ($order->status !== Order::PENDING_PAYMENT || (! $force && $order->payment_expires_at?->isFuture())) {
            return $order;
        }
        foreach ($this->openCharges($order) as $charge) {
            $this->verify($charge);
        }
        $this->orders->systemCancel($order, 'payment_timeout', function (Order $o) use ($force) {
            if ($o->status !== Order::PENDING_PAYMENT || (! $force && $o->payment_expires_at?->isFuture())) {
                return false;
            }
            foreach ($this->openCharges($o, lock: true) as $charge) {
                if (PaymentStateMachine::move($charge, PaymentStateMachine::PENDING, PaymentStateMachine::CANCELLED, ['failure_code' => 'expired'])) {
                    OrderTimeline::record($o, 'payment', null, null, [
                        'payment_id' => $charge->id, 'provider' => $charge->provider, 'purpose' => $charge->purpose,
                        'amount' => $charge->amount, 'status' => 'cancelled', 'failure_code' => 'expired', 'source' => 'expiry',
                    ]);
                }
            }

            return true;
        });

        return $order->refresh();
    }

    /** @return list<Payment> pending online charges of an order */
    public function openCharges(Order $order, bool $lock = false): array
    {
        $query = Payment::query()->where('order_id', $order->id)->where('type', Payment::TYPE_CHARGE)
            ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('status', Payment::STATUS_PENDING)->orderBy('created_at')->orderBy('id');
        if ($lock) {
            $query->lockForUpdate();
        }

        return $query->get()->all();
    }

    // ------------------------------------------------------------------ shopper retry / switch to COD (P5B-17)

    /** @return array{order: Order, payment: array<string, mixed>|null} */
    public function retry(Order $order, string $method): array
    {
        $this->assertHoldOpen($order->refresh());
        // The open attempt is verified first (outside any lock): it may have been paid in another tab.
        foreach ($this->openCharges($order) as $charge) {
            $this->verify($charge);
        }

        $settings = StoreSetting::query()->where('store_id', $order->store_id)->first();
        [$order, $payment] = DB::transaction(function () use ($order, $method, $settings) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            $this->assertHoldOpen($o);
            $previous = Payment::query()->where('order_id', $o->id)->where('type', Payment::TYPE_CHARGE)->whereIn('provider', Payment::ONLINE_PROVIDERS)
                ->orderByDesc('created_at')->orderByDesc('id')->first();
            $purpose = $previous?->purpose === Payment::PURPOSE_ADVANCE ? Payment::PURPOSE_ADVANCE : Payment::PURPOSE_ORDER;

            if ($method === 'cod') {
                if (! (bool) ($settings?->cod_enabled ?? true) || $purpose === Payment::PURPOSE_ADVANCE || self::advanceRequired($settings, $o->shipping_amount)) {
                    throw self::methodUnavailable('payment_method', 'Cash on delivery isn’t available for this order.');
                }
            } elseif ($this->usableAccount($o->store_id, $method) === null) {
                throw self::methodUnavailable('payment_method', 'This payment method isn’t available.');
            }
            foreach ($this->openCharges($o, lock: true) as $charge) {
                if (PaymentStateMachine::move($charge, PaymentStateMachine::PENDING, PaymentStateMachine::CANCELLED, ['failure_code' => 'superseded'])) {
                    OrderTimeline::record($o, 'payment', null, null, ['payment_id' => $charge->id, 'provider' => $charge->provider, 'purpose' => $charge->purpose, 'amount' => $charge->amount, 'status' => 'cancelled', 'failure_code' => 'superseded', 'source' => 'retry']);
                }
            }

            if ($method === 'cod') {
                $o->status = Order::PENDING;
                $o->payment_method = 'cod';
                $o->revision++;
                $o->save();
                if ($o->dueAmount() > 0 && ! Payment::query()->where('order_id', $o->id)->where('provider', Payment::PROVIDER_COD)->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)->exists()) {
                    $cod = new Payment;
                    $cod->store_id = $o->store_id;
                    $cod->order_id = $o->id;
                    $cod->provider = Payment::PROVIDER_COD;
                    $cod->type = Payment::TYPE_CHARGE;
                    $cod->status = Payment::STATUS_PENDING;
                    $cod->amount = $o->dueAmount();
                    $cod->currency = $o->currency;
                    $cod->save();
                }
                OrderTimeline::record($o, 'status_changed', null, null, ['reason' => 'switched_to_cod'], Order::PENDING_PAYMENT, Order::PENDING, 'customer');

                return [$o, null];
            }

            $account = $this->usableAccount($o->store_id, $method);
            $amount = $purpose === Payment::PURPOSE_ADVANCE ? (int) ($previous->amount ?? $o->shipping_amount) : $o->dueAmount();
            $charge = $this->newCharge($o, $account, $purpose, $amount, $o->payment_expires_at ?? now()->addMinutes((int) config('payments.hold_minutes', 30)));
            if ($purpose === Payment::PURPOSE_ORDER && $o->payment_method !== $method) {
                $o->payment_method = $method;
                $o->revision++;
                $o->save();
            }

            return [$o, $charge];
        });

        if ($payment === null) {
            $this->notifier->placed($order, null);

            return ['order' => $order, 'payment' => null];
        }

        return ['order' => $order->refresh(), 'payment' => $this->initiate($payment)];
    }

    private function assertHoldOpen(Order $order): void
    {
        if ($order->status !== Order::PENDING_PAYMENT || $order->payment_expires_at === null || ! $order->payment_expires_at->isFuture()) {
            throw new ApiException(409, 'payment_not_pending', 'This order isn’t waiting for a payment any more.');
        }
    }

    public static function methodUnavailable(string $field, string $message): ApiException
    {
        return new ApiException(422, 'payment_method_unavailable', $message, [$field => [$message]]);
    }

    // ------------------------------------------------------------------ refunds (P5B-24, P5B-25)

    /**
     * Merchant gateway refund: the refund row is committed `pending`, the provider is called outside any transaction,
     * and amounts change only on provider success. Provider refusal → 422 `gateway_refund_rejected`; timeout → one
     * refund-status check, then 502 `provider_unavailable` (row `failed`, retry with a new key).
     *
     * @param  array{amount: int, payment_id: string, note?: string|null, return_id?: string|null}  $input
     */
    public function refund(Order $order, array $input, ?string $idempotencyKey, ?User $user): Payment
    {
        $refund = DB::transaction(function () use ($order, $input, $idempotencyKey, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            $charge = Payment::query()->where('order_id', $o->id)->whereKey(strtolower((string) $input['payment_id']))->lockForUpdate()->first();
            if ($charge === null || $charge->type !== Payment::TYPE_CHARGE || ! $charge->isOnline() || $charge->status !== PaymentStateMachine::SUCCEEDED) {
                throw ValidationException::withMessages(['payment_id' => ['Choose an online payment of this order that went through.']]);
            }
            if (! GatewayCapabilities::supportsRefund($charge->provider)) {
                // PHASE-8-9D P89D-48: Nagad refunds are made in the merchant portal until certified.
                throw new ApiException(422, 'gateway_refund_unsupported', 'Refund in the '.self::providerLabel($charge->provider).' merchant portal, then record a manual refund.',
                    ['payment_id' => ['This gateway can’t refund from Store Plix yet.']]);
            }
            $amount = (int) $input['amount'];
            $left = min($this->chargeRefundable($charge), $this->orderRefundable($o));
            if ($amount > $left) {
                $message = $left > 0 ? 'You can refund at most '.Money::bdt($left).' to this payment.' : 'This payment has been refunded in full.';
                throw new ApiException(422, 'refund_exceeds_paid', $message, ['amount' => [$message]]);
            }
            if ($amount < self::MIN_REFUND) {
                throw ValidationException::withMessages(['amount' => ['The smallest refund is '.Money::bdt(self::MIN_REFUND).'.']]);
            }
            $return = ($input['return_id'] ?? null) !== null ? $this->returns->assertRefundable($o, (string) $input['return_id'], $amount) : null;

            return $this->newRefund($charge, $amount, $input['note'] ?? null, $idempotencyKey, $user, $return?->id);
        });

        // The merchant sees a synchronous failure right away (422/502): no email for it.
        $result = $this->requestRefund($refund, $input['note'] ?? null, alert: false);
        if ($result instanceof GatewayException) {
            DB::table('payments')->where('id', $refund->id)->update(['idempotency_key' => null]);
            throw new ApiException($result->httpStatus(), $result->errorCode, match ($result->errorCode) {
                GatewayException::PROVIDER_UNAVAILABLE => 'The payment provider didn’t answer. Nothing was refunded; try again in a minute.',
                GatewayException::NOT_CONNECTED => 'This payment method isn’t connected any more. Record a manual refund instead.',
                default => 'The payment provider refused this refund. Record a manual refund instead.',
            }, $result->errorCode === GatewayException::REFUND_REJECTED ? ['amount' => ['The payment provider refused this refund.']] : null);
        }

        return $refund->refresh();
    }

    /** Charge balance left for new refunds (pending refunds count as spent). */
    public function chargeRefundable(Payment $charge): int
    {
        $pending = (int) Payment::query()->where('parent_payment_id', $charge->id)->where('type', Payment::TYPE_REFUND)->where('status', Payment::STATUS_PENDING)->sum('amount');

        return max(0, (int) $charge->amount - (int) $charge->refunded_amount - $pending);
    }

    private function orderRefundable(Order $o): int
    {
        $pending = (int) Payment::query()->where('order_id', $o->id)->where('type', Payment::TYPE_REFUND)->where('status', Payment::STATUS_PENDING)->sum('amount');

        return max(0, $o->paid_amount - $o->refunded_amount - $pending);
    }

    private function newRefund(Payment $charge, int $amount, ?string $note, ?string $idempotencyKey, ?User $user, ?string $returnId): Payment
    {
        $refund = new Payment;
        $refund->store_id = $charge->store_id;
        $refund->order_id = $charge->order_id;
        $refund->provider = $charge->provider;
        $refund->type = Payment::TYPE_REFUND;
        $refund->status = Payment::STATUS_PENDING;
        $refund->amount = $amount;
        $refund->currency = $charge->currency;
        $refund->method = Payment::METHOD_GATEWAY;
        $refund->note = $note;
        $refund->parent_payment_id = $charge->id;
        $refund->idempotency_key = $idempotencyKey;
        $refund->actor_user_id = $user?->getKey();
        $refund->purpose = $charge->purpose;
        $refund->gateway_account_id = $charge->gateway_account_id;
        $refund->return_request_id = $returnId;
        $refund->save();

        return $refund;
    }

    /** Calls the provider for a committed pending refund and applies the answer. Returns the failure, if any. */
    private function requestRefund(Payment $refund, ?string $reason, bool $alert = true): ?GatewayException
    {
        $charge = Payment::query()->findOrFail($refund->parent_payment_id);
        $account = PaymentGatewayAccount::query()->find($refund->gateway_account_id);
        $driver = $this->gateways->driver($refund->provider);
        try {
            if ($account === null || ! $account->isConnected()) {
                throw new GatewayException(GatewayException::NOT_CONNECTED);
            }
            $result = $driver->refund($charge, $refund, $account, (int) $refund->amount, $reason);
        } catch (GatewayException $e) {
            if ($e->errorCode === GatewayException::PROVIDER_UNAVAILABLE && $account !== null) {
                try {
                    $status = $driver->refundStatus($refund, $account);
                    if ($status->status !== RefundResult::FAILED) {
                        $this->applyRefund($refund, $status, $alert);

                        return null;
                    }
                } catch (GatewayException) {
                    // fall through: failed, retry with a new key
                }
            }
            $this->applyRefund($refund, new RefundResult(RefundResult::FAILED, null, $e->errorCode), $alert);

            return $e;
        }
        $this->applyRefund($refund, $result, $alert);

        return $result->status === RefundResult::FAILED ? new GatewayException(GatewayException::REFUND_REJECTED) : null;
    }

    /** Applies a provider refund answer to a pending refund row (sync answer or payments:refund-status). */
    public function applyRefund(Payment $refund, RefundResult $result, bool $alert = true): void
    {
        $failed = DB::transaction(function () use ($refund, $result) {
            $order = $this->lockOrder($refund);
            $charge = Payment::query()->whereKey($refund->parent_payment_id)->lockForUpdate()->first();
            $providerId = $result->providerRefundId !== null ? mb_substr($result->providerRefundId, 0, 64) : null;
            if ($result->status === RefundResult::PROCESSING) {
                DB::table('payments')->where('id', $refund->id)->where('status', PaymentStateMachine::PENDING)->update(array_filter([
                    'provider_payment_id' => $providerId, 'raw' => json_encode(['refund' => $result->raw]), 'updated_at' => now(),
                ], fn ($v) => $v !== null));

                return false;
            }
            if ($result->status === RefundResult::FAILED) {
                $moved = PaymentStateMachine::move($refund, PaymentStateMachine::PENDING, PaymentStateMachine::FAILED, [
                    'failure_code' => mb_substr($result->failureCode ?? 'refund_failed', 0, 48), 'raw' => json_encode(['refund' => $result->raw]),
                ]);
                if ($moved && $order !== null) {
                    OrderTimeline::record($order, 'refund', null, 'The refund through '.self::providerLabel($refund->provider).' failed.', [
                        'amount' => $refund->amount, 'method' => Payment::METHOD_GATEWAY, 'payment_id' => $refund->id, 'status' => 'failed', 'failure_code' => $result->failureCode,
                    ]);
                }

                return $moved;
            }
            if (! PaymentStateMachine::move($refund, PaymentStateMachine::PENDING, PaymentStateMachine::SUCCEEDED, [
                'provider_trx_id' => $providerId, 'provider_payment_id' => $providerId ?? $refund->provider_payment_id, 'verified_at' => now(),
                'raw' => json_encode(['refund' => $result->raw]),
            ])) {
                return false;
            }
            $amount = (int) $refund->amount;
            if ($charge !== null) {
                DB::table('payments')->where('id', $charge->id)->update(['refunded_amount' => DB::raw('refunded_amount + '.$amount), 'updated_at' => now()]);
            }
            if ($order === null) {
                return false;
            }
            $order->refunded_amount += $amount;
            $order->payment_status = self::paymentStatus($order);
            $order->revision++;
            $order->save();
            if ($order->customer_id !== null && $order->delivered_at !== null) {
                Customer::withTrashed()->whereKey($order->customer_id)->update([
                    'total_spent_amount' => DB::raw("CASE WHEN total_spent_amount >= {$amount} THEN total_spent_amount - {$amount} ELSE 0 END"),
                ]);
            }
            $return = $refund->return_request_id !== null ? ReturnRequest::query()->whereKey($refund->return_request_id)->lockForUpdate()->first() : null;
            $actor = $refund->actor_user_id !== null ? User::query()->find($refund->actor_user_id) : null;
            if ($return !== null) {
                $this->returns->recordRefund($return, $refund, $actor);
            }
            OrderTimeline::record($order, 'refund', $actor, $refund->note, ['amount' => $amount, 'method' => Payment::METHOD_GATEWAY, 'provider' => $refund->provider, 'payment_id' => $refund->id]
                + ($return !== null ? ['return_id' => $return->id, 'return_number' => $return->number] : []));
            $this->audit->log('order.refunded', $order, ['amount' => $amount, 'method' => Payment::METHOD_GATEWAY], $actor, null, $actor === null);
            TrackingHooks::refund($order->id, $refund->id, $amount); // PHASE-8-9D §5.4 (GA4 / GTM, after commit)

            return false;
        });
        if ($alert && $failed && $refund->order_id !== null && $refund->purpose !== Payment::PURPOSE_TEST) {
            SendPaymentAlert::dispatch($refund->order_id, SendPaymentAlert::REFUND_FAILED, $refund->id)->forTenant($refund->tenant_id)->onQueue(OrderNotifier::QUEUE);
        }
    }

    /** Re-checks a refund the provider reported as processing (payments:refund-status). */
    public function syncRefund(Payment $refund): void
    {
        $account = PaymentGatewayAccount::query()->find($refund->gateway_account_id);
        if ($account === null || $refund->status !== PaymentStateMachine::PENDING) {
            return;
        }
        try {
            $result = $this->gateways->driver($refund->provider)->refundStatus($refund, $account);
        } catch (GatewayException $e) {
            Log::warning('payments.refund_status_failed', ['payment_id' => $refund->id, 'code' => $e->errorCode]);

            return;
        }
        $this->applyRefund($refund, $result);
    }

    /**
     * Full refund of a charge that can't be kept (late payment, test payment). At most one: an existing pending or
     * succeeded refund of the charge makes this a no-op (S31).
     */
    public function autoRefund(Payment $charge, string $reason): ?Payment
    {
        $refund = DB::transaction(function () use ($charge, $reason) {
            $this->lockOrder($charge);
            /** @var Payment|null $c */
            $c = Payment::query()->whereKey($charge->id)->lockForUpdate()->first();
            if ($c === null || $c->status !== PaymentStateMachine::SUCCEEDED || ! GatewayCapabilities::supportsRefund($c->provider)) {
                return null; // P89D-48: no gateway refund for Nagad (the merchant refunds in the Nagad portal)
            }
            if (Payment::query()->where('parent_payment_id', $c->id)->where('type', Payment::TYPE_REFUND)->whereIn('status', [Payment::STATUS_PENDING, Payment::STATUS_SUCCEEDED])->exists()) {
                return null;
            }
            $amount = $this->chargeRefundable($c);

            return $amount > 0 ? $this->newRefund($c, $amount, $reason, null, null, null) : null;
        });
        if ($refund === null) {
            return null;
        }
        $this->requestRefund($refund, $reason);

        return $refund->refresh();
    }

    /**
     * P5B-25: after a merchant cancel, refund the online payments of the order (each charge's balance). A failure
     * leaves a timeline event; the charge keeps `can_refund` for the "Refund failed — retry" action.
     */
    public function refundCancelledOrder(Order $order, ?User $user): void
    {
        $charges = Payment::query()->where('order_id', $order->id)->where('type', Payment::TYPE_CHARGE)->whereIn('provider', Payment::ONLINE_PROVIDERS)
            ->where('status', Payment::STATUS_SUCCEEDED)->orderBy('created_at')->get()
            ->filter(fn (Payment $c) => GatewayCapabilities::supportsRefund($c->provider)); // P89D-48: cancel-and-refund off for Nagad
        foreach ($charges as $charge) {
            $refund = DB::transaction(function () use ($order, $charge, $user) {
                /** @var Order $o */
                $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
                $c = Payment::query()->whereKey($charge->id)->lockForUpdate()->firstOrFail();
                $amount = min($this->chargeRefundable($c), $this->orderRefundable($o));

                return $amount >= self::MIN_REFUND ? $this->newRefund($c, $amount, 'Order cancelled', null, $user, null) : null;
            });
            if ($refund !== null) {
                $this->requestRefund($refund, 'Order cancelled');
            }
        }
    }

    public static function providerLabel(string $provider): string
    {
        return match ($provider) {
            PaymentGatewayAccount::SSLCOMMERZ => 'SSLCommerz',
            PaymentGatewayAccount::NAGAD => 'Nagad',
            default => 'bKash',
        };
    }

    private function lockOrder(Payment $payment): ?Order
    {
        return $payment->order_id !== null ? Order::query()->whereKey($payment->order_id)->lockForUpdate()->first() : null;
    }
}
