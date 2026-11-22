<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderService;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\ValidationException;

/**
 * Merchant payment links (P5B-22, P5B-23). One active link per order; token = 12 random base62 characters (~71 bits)
 * stored as sha256 (lookup) and encrypted (Copy link / Resend). A paid link confirms a pending order; an unpaid link
 * with `cancel_if_unpaid` cancels the order at expiry (`payment_link_expired`, stock released).
 */
class PaymentLinkService
{
    public const LINK_ORDER_STATUSES = [Order::PENDING, Order::CONFIRMED, Order::READY_TO_SHIP];

    public const RESENDS_PER_HOUR = 3;

    public function __construct(
        private readonly PaymentService $payments,
        private readonly OrderService $orders,
        private readonly OrderNotifier $notifier,
    ) {}

    /**
     * Caller may already hold the order lock (exchange orders): the nested transaction is a savepoint.
     *
     * @param  array{amount_kind: string, percent_bps?: int|null, amount?: int|null, provider: string, expires_in_minutes: int, cancel_if_unpaid: bool, send_sms: bool}  $input
     */
    public function create(Order $order, array $input, ?User $user): PaymentLink
    {
        $link = DB::transaction(function () use ($order, $input, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if (! in_array($o->status, self::LINK_ORDER_STATUSES, true)) {
                throw new ApiException(409, 'invalid_state_transition', 'You can ask for a payment only on pending, confirmed or packed orders.');
            }
            $due = $o->dueAmount();
            if ($due <= 0) {
                throw new ApiException(409, 'invalid_state_transition', 'Nothing is due on this order.');
            }
            if (PaymentLink::query()->where('order_id', $o->id)->where('status', PaymentLink::ACTIVE)->where('expires_at', '>', now())->exists()) {
                throw new ApiException(409, 'payment_link_active', 'This order already has an active payment link. Cancel it first.');
            }
            if ($this->payments->usableAccount($o->store_id, $input['provider']) === null) {
                throw new ApiException(422, 'gateway_not_connected', 'Connect and turn on this payment method first.', ['provider' => ['This payment method isn’t connected.']]);
            }
            [$amount, $bps] = self::amount($o, $input, $due);

            // An active link past its expiry (the job hasn't run yet) makes room for the new one.
            PaymentLink::query()->where('order_id', $o->id)->where('status', PaymentLink::ACTIVE)->where('expires_at', '<=', now())
                ->update(['status' => PaymentLink::EXPIRED, 'updated_at' => now()]);

            $token = self::newToken();
            $link = new PaymentLink;
            $link->store_id = $o->store_id;
            $link->order_id = $o->id;
            $link->token_hash = PaymentLink::hashToken($token);
            $link->token_encrypted = Crypt::encryptString($token);
            $link->amount_kind = $input['amount_kind'];
            $link->percent_bps = $bps;
            $link->amount = $amount;
            $link->provider = $input['provider'];
            $link->status = PaymentLink::ACTIVE;
            $link->expires_at = now()->addMinutes((int) $input['expires_in_minutes']);
            $link->cancel_if_unpaid = (bool) $input['cancel_if_unpaid'];
            $link->sent_via = $input['send_sms'] ? ['sms'] : [];
            $link->created_by = $user?->getKey();
            try {
                DB::transaction(fn () => $link->save());
            } catch (UniqueConstraintViolationException) {
                throw new ApiException(409, 'payment_link_active', 'This order already has an active payment link. Cancel it first.');
            }
            OrderTimeline::record($o, 'payment_link', $user, null, [
                'action' => 'created', 'link_id' => $link->id, 'amount' => $amount, 'amount_kind' => $link->amount_kind,
                'provider' => $link->provider, 'expires_at' => $link->expires_at->toIso8601ZuluString(), 'cancel_if_unpaid' => $link->cancel_if_unpaid,
            ]);

            return $link;
        });
        if ($input['send_sms']) {
            $this->sendSms($order, $link, 1);
        }

        return $link;
    }

    /** @param array<string, mixed> $input @return array{0: int, 1: int|null} amount, percent_bps */
    public static function amount(Order $o, array $input, int $due): array
    {
        $bps = null;
        $amount = match ($input['amount_kind']) {
            'delivery_charge' => $o->shipping_amount,
            'percent' => intdiv($due * ($bps = (int) ($input['percent_bps'] ?? 2500)), 10000),
            'full' => $due,
            'custom' => (int) ($input['amount'] ?? 0),
            default => 0,
        };
        if ($input['amount_kind'] === 'delivery_charge' && ($amount <= 0 || $amount > $due)) {
            throw ValidationException::withMessages(['amount_kind' => [$amount <= 0 ? 'This order has no delivery charge.' : 'The delivery charge is more than what is due.']]);
        }
        if ($amount < 1 || $amount > $due) {
            $field = $input['amount_kind'] === 'percent' ? 'percent_bps' : 'amount';
            throw ValidationException::withMessages([$field => ['The amount must be between '.Money::bdt(1).' and the due '.Money::bdt($due).'.']]);
        }

        return [$amount, $bps];
    }

    public function resend(PaymentLink $link, ?User $user): PaymentLink
    {
        if (PaymentPresenter::linkStatus($link) !== PaymentLink::ACTIVE) {
            throw new ApiException(409, 'invalid_state_transition', 'This payment link isn’t active any more.');
        }
        $key = app(TenantCache::class)->key('payment-link-resend:'.$link->id);
        if (RateLimiter::tooManyAttempts($key, self::RESENDS_PER_HOUR)) {
            $retry = RateLimiter::availableIn($key);
            throw new ApiException(429, 'rate_limited', 'This link was sent 3 times in the last hour. Try again later.', null, $retry);
        }
        RateLimiter::hit($key, 3600);
        $order = Order::query()->findOrFail($link->order_id);
        OrderTimeline::record($order, 'payment_link', $user, null, ['action' => 'resent', 'link_id' => $link->id]);
        if (! in_array('sms', (array) $link->sent_via, true)) {
            $link->sent_via = ['sms'];
            $link->save();
        }
        $this->sendSms($order, $link, $this->sentCount($link));

        return $link;
    }

    public function cancel(PaymentLink $link, ?User $user): void
    {
        DB::transaction(function () use ($link, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($link->order_id)->lockForUpdate()->firstOrFail();
            /** @var PaymentLink $l */
            $l = PaymentLink::query()->whereKey($link->id)->lockForUpdate()->firstOrFail();
            if ($l->status === PaymentLink::PAID) {
                throw new ApiException(409, 'invalid_state_transition', 'This payment link was paid already. Refund the payment instead.');
            }
            if ($l->status !== PaymentLink::ACTIVE) {
                return;
            }
            $l->status = PaymentLink::CANCELLED;
            $l->cancelled_at = now();
            $l->save();
            $this->closeAttempts($o, $l, 'link_cancelled');
            OrderTimeline::record($o, 'payment_link', $user, null, ['action' => 'cancelled', 'link_id' => $l->id]);
        });
    }

    /**
     * payment-links:expire. Pending attempts are verified first (a paid link is applied, not expired); then the link
     * expires and, with `cancel_if_unpaid`, an unpaid order is cancelled (`payment_link_expired`, stock released).
     */
    public function expire(PaymentLink $link, bool $force = false): void
    {
        if ($link->status !== PaymentLink::ACTIVE || (! $force && $link->expires_at->isFuture())) {
            return;
        }
        foreach (Payment::query()->where('payment_link_id', $link->id)->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)->get() as $attempt) {
            $this->payments->verify($attempt);
        }
        $order = Order::query()->find($link->order_id);
        if ($order === null) {
            return;
        }
        $this->orders->systemCancel($order, 'payment_link_expired', function (Order $o) use ($link, $force) {
            /** @var PaymentLink|null $l */
            $l = PaymentLink::query()->whereKey($link->id)->lockForUpdate()->first();
            if ($l === null || $l->status !== PaymentLink::ACTIVE || (! $force && $l->expires_at->isFuture())) {
                return false;
            }
            $l->status = PaymentLink::EXPIRED;
            if ($force) {
                $l->expires_at = now()->subSecond();
            }
            $l->save();
            $this->closeAttempts($o, $l, 'expired');
            OrderTimeline::record($o, 'payment_link', null, null, ['action' => 'expired', 'link_id' => $l->id, 'cancel_if_unpaid' => $l->cancel_if_unpaid]);

            return $l->cancel_if_unpaid && in_array($o->status, self::LINK_ORDER_STATUSES, true);
        });
    }

    /**
     * Shopper pays a link (POST /storefront/payment-links/{token}/pay): a previous open attempt is verified, then
     * superseded; a new attempt is committed and initiated outside the transaction.
     *
     * @return array<string, mixed> PaymentInitiation
     */
    public function pay(PaymentLink $link): array
    {
        foreach (Payment::query()->where('payment_link_id', $link->id)->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)->get() as $attempt) {
            $this->payments->verify($attempt);
        }
        $payment = DB::transaction(function () use ($link) {
            /** @var Order $o */
            $o = Order::query()->whereKey($link->order_id)->lockForUpdate()->firstOrFail();
            /** @var PaymentLink $l */
            $l = PaymentLink::query()->whereKey($link->id)->lockForUpdate()->firstOrFail();
            if (! self::payable($l, $o)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $account = $this->payments->usableAccount($o->store_id, $l->provider);
            if ($account === null) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $this->closeAttempts($o, $l, 'superseded');

            return $this->payments->newCharge($o, $account, Payment::PURPOSE_LINK, (int) $l->amount, $l->expires_at, $l);
        });

        return $this->payments->initiate($payment);
    }

    /** Active, not expired, order still open and the amount still due (P5B-23: anything else is the same 404). */
    public static function payable(PaymentLink $link, Order $order): bool
    {
        return $link->status === PaymentLink::ACTIVE && $link->expires_at->isFuture()
            && in_array($order->status, self::LINK_ORDER_STATUSES, true) && $order->dueAmount() >= $link->amount;
    }

    public static function byToken(string $storeId, string $token): ?PaymentLink
    {
        if (preg_match('/^[A-Za-z0-9]{12}$/', $token) !== 1) {
            return null;
        }

        return PaymentLink::query()->where('store_id', $storeId)->where('token_hash', PaymentLink::hashToken($token))->first();
    }

    public static function newToken(): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $token = '';
        for ($i = 0; $i < 12; $i++) {
            $token .= $alphabet[random_int(0, 61)];
        }

        return $token;
    }

    private function closeAttempts(Order $o, PaymentLink $l, string $code): void
    {
        $attempts = Payment::query()->where('payment_link_id', $l->id)->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)->lockForUpdate()->get();
        foreach ($attempts as $attempt) {
            if (PaymentStateMachine::move($attempt, PaymentStateMachine::PENDING, PaymentStateMachine::CANCELLED, ['failure_code' => $code])) {
                OrderTimeline::record($o, 'payment', null, null, ['payment_id' => $attempt->id, 'provider' => $attempt->provider, 'purpose' => $attempt->purpose, 'amount' => $attempt->amount, 'status' => 'cancelled', 'failure_code' => $code, 'source' => 'link']);
            }
        }
    }

    private function sentCount(PaymentLink $link): int
    {
        return 1 + (int) DB::table('order_events')->where('order_id', $link->order_id)->where('type', 'payment_link')
            ->where('meta->link_id', $link->id)->where('meta->action', 'resent')->count();
    }

    /** One SMS per (link, send #): SendOrderSms dedupes on the ref, so a retried job never sends twice. */
    private function sendSms(Order $order, PaymentLink $link, int $count): void
    {
        $this->notifier->sms($order, 'payment_link', true, null, $link->id.':'.$count);
    }
}
