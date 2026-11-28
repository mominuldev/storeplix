<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Identity\Models\User;
use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\SmsPurposes;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * The till sale (PHASE-8-8D §5.2, §6, P88D-2/6/7/9/10/12/13, ADR 0025), one transaction in the §3.3 lock order:
 * session row FOR SHARE (must be open) → store order advisory lock → stock rows at the register location → coupon →
 * customer → counter. A pre-check prices the sale without locks so a changed total (409 `checkout_changed`) or wrong
 * payments (422) fail before any row is locked; OrderPlacementService::pos re-prices under the locks. Then one manual,
 * succeeded payment row per part bound to the session, and the 1:1 `pos_sales` row. After commit: webhooks
 * `order.created` / `order.paid`, and the SMS receipt when ticked and there is a phone.
 */
final class PosSaleService
{
    public function __construct(
        private readonly OrderPlacementService $placement,
        private readonly PosPricing $pricing,
        private readonly TenantContext $context,
    ) {}

    /**
     * The open session of this store named by the body (S202: never an implicit default). Unknown → 422
     * `session_id`; closed → 409 `register_closed`. $lock: FOR SHARE (sale) inside the caller's transaction.
     */
    public static function openSession(Store $store, string $sessionId, bool $lock = false): PosSession
    {
        $session = PosSession::query()->where('store_id', $store->id)->whereKey(strtolower($sessionId))
            ->when($lock, fn ($q) => $q->sharedLock())->first();
        if ($session === null) {
            throw ValidationException::withMessages(['session_id' => ['Unknown register session.']]);
        }
        if (! $session->isOpen()) {
            throw new ApiException(409, 'register_closed', 'This register is closed. Open it again to sell.');
        }

        return $session;
    }

    /**
     * The held sale a sale resumes, locked FOR UPDATE: another store's, an unknown or an already completed / deleted
     * one → 422 `held_sale_id`; one of another register of this store → 422 (S207).
     */
    private static function heldFor(Store $store, PosRegister $register, ?string $heldId): ?PosHeldSale
    {
        if ($heldId === null || $heldId === '') {
            return null;
        }
        $held = PosHeldSale::query()->where('store_id', $store->id)->whereKey(strtolower($heldId))->lockForUpdate()->first();
        if ($held === null) {
            throw ValidationException::withMessages(['held_sale_id' => ['This held sale was already completed or deleted.']]);
        }
        if ($held->register_id !== $register->id) {
            throw ValidationException::withMessages(['held_sale_id' => ['This held sale belongs to another register.']]);
        }

        return $held;
    }

    /**
     * The customer of the sale (P88D-10): `customer_id` (this store's), else `customer {phone, name?}` (normalised
     * 8801…; an existing customer keeps their name; a new phone needs a name), else walk-in (null).
     *
     * @param  array<string, mixed>  $input
     * @return array{id?: string, phone: string, name: string}|null
     */
    public static function customerFor(Store $store, array $input): ?array
    {
        if (($input['customer_id'] ?? null) !== null) {
            $customer = Customer::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['customer_id']))->first()
                ?? throw ValidationException::withMessages(['customer_id' => ['Unknown customer.']]);
            if ($customer->phone === null || $customer->phone === '') {
                throw ValidationException::withMessages(['customer_id' => ['This customer has no phone number.']]);
            }

            return ['id' => $customer->id, 'phone' => (string) $customer->phone, 'name' => (string) $customer->name];
        }
        if (($input['customer'] ?? null) !== null) {
            $phone = (string) $input['customer']['phone']; // already normalised by the request
            $existing = Customer::query()->where('store_id', $store->id)->where('phone', $phone)->first();
            if ($existing !== null) {
                return ['id' => $existing->id, 'phone' => $phone, 'name' => (string) $existing->name];
            }
            $name = trim((string) ($input['customer']['name'] ?? ''));
            if ($name === '') {
                throw ValidationException::withMessages(['customer.name' => ['Enter the new customer’s name.']]);
            }

            return ['phone' => $phone, 'name' => $name];
        }

        return null;
    }

    /** @param array<string, mixed> $input validated PosSaleInput */
    public function sell(Store $store, array $input, User $user, ?string $idempotencyKey): PosSale
    {
        $customer = self::customerFor($store, $input);
        $phone = $customer['phone'] ?? null;

        $sale = DB::transaction(function () use ($store, $input, $user, $idempotencyKey, $customer, $phone) {
            // 1. Session open and in this store (FOR SHARE: a close waits for us, or we see `closed`).
            $session = self::openSession($store, (string) $input['session_id'], lock: true);
            /** @var PosRegister $register */
            $register = PosRegister::query()->whereKey($session->register_id)->firstOrFail();
            // 1b. A resumed held sale (P88D-16, S207): this register's, locked so two resumes can't both complete it.
            $held = self::heldFor($store, $register, $input['held_sale_id'] ?? null);

            // 2–3. Unlocked pre-check: server total vs the client's, payments vs the total.
            ['loaded' => $loaded, 'plain' => $plain] = PosPricing::load($store->id, $input['lines'], strict: true);
            $priced = $this->pricing->applyCoupon($store->id, $loaded, $plain, $input['coupon_code'] ?? null, $phone)['priced'];
            $total = (int) $priced['subtotal'] - (int) $priced['discount'];
            if ((int) $input['expected_total_amount'] !== $total) {
                throw new ApiException(409, 'checkout_changed', 'The total changed. Check the sale and charge again.', [
                    'expected_total_amount' => ['The total changed to '.Money::bdt($total).'. Check the sale and charge again.'],
                    'quote' => $this->pricing->quote($store->id, $session->location_id, $session->currency, $input['lines'], $input['coupon_code'] ?? null, $phone),
                ]);
            }
            $settled = PosMoney::settle($total, $input['payments'], isset($input['tendered_cash_amount']) ? (int) $input['tendered_cash_amount'] : null);

            // 4–5. Store order lock, plan limit, then the order (stock → coupon → customer → counter).
            if (DB::getDriverName() === 'pgsql') {
                DB::select('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['orders:'.$store->id]);
            }
            FeatureGate::assertWithin($this->context->tenant(), Limit::OrdersPerMonth);
            $order = $this->placement->pos($store, [
                'lines' => $input['lines'],
                'location_id' => $session->location_id,
                'coupon_code' => $input['coupon_code'] ?? null,
                'expected_total' => (int) $input['expected_total_amount'],
                'customer' => $customer,
                'user' => $user,
                'idempotency_key' => $idempotencyKey,
                'note' => $input['note'] ?? null,
                'timeline' => ['register_id' => $register->id, 'register_name' => $register->name, 'session_id' => $session->id] + ($held !== null ? ['held_sale_id' => $held->id] : []),
            ]);

            // 6. Payment rows (P88D-9): manual, succeeded, verified, bound to the session; change is never a payment.
            $now = now();
            $parts = [];
            foreach (array_values($input['payments']) as $p) {
                $payment = new Payment;
                $payment->store_id = $store->id;
                $payment->order_id = $order->id;
                $payment->provider = Payment::PROVIDER_MANUAL;
                $payment->type = Payment::TYPE_CHARGE;
                $payment->status = Payment::STATUS_SUCCEEDED;
                $payment->purpose = Payment::PURPOSE_ORDER;
                $payment->amount = (int) $p['amount'];
                $payment->currency = $order->currency;
                $payment->method = $p['method'];
                $payment->reference = $p['method'] !== 'cash' && isset($p['reference']) && trim((string) $p['reference']) !== '' ? trim((string) $p['reference']) : null;
                $payment->verified_at = $now;
                $payment->actor_user_id = $user->id;
                $payment->pos_session_id = $session->id;
                $payment->save();
                $parts[] = ['method' => $payment->method, 'amount' => (int) $payment->amount, 'payment_id' => $payment->id];
            }
            OrderTimeline::record($order, 'payment', $user, null, [
                'amount' => $order->total_amount, 'payments' => $parts, 'session_id' => $session->id, 'register_id' => $register->id,
                'tendered_cash_amount' => $settled['tendered_cash_amount'], 'change_amount' => $settled['change_amount'],
            ]);
            if ($order->total_amount > 0) {
                WebhookEvents::emit(WebhookEventType::OrderPaid, $order);
            }

            $sale = new PosSale;
            $sale->store_id = $store->id;
            $sale->order_id = $order->id;
            $sale->session_id = $session->id;
            $sale->register_id = $register->id;
            $sale->location_id = $session->location_id;
            $sale->cashier_id = $user->id;
            $sale->tendered_cash_amount = $settled['tendered_cash_amount'];
            $sale->change_amount = $settled['change_amount'];
            $sale->sms_receipt = (bool) $input['sms_receipt'] && $phone !== null;
            $sale->created_at = $now;
            $sale->save();
            if ($held !== null) {
                PosHeldSale::query()->whereKey($held->id)->delete(); // the sale completes the held one
            }

            // 7. SMS receipt after commit (P88D-12): only to the sale's phone, counted in sms_per_month.
            if ($sale->sms_receipt) {
                self::queueReceipt($order, 'sale');
            }

            return $sale;
        });

        return $sale;
    }

    /**
     * Send or resend the SMS receipt (§7, S204): only to the phone stored on the sale's order (a walk-in → 422
     * `no_phone`); the monthly allowance is checked now (402 `plan_limit_reached`) and again by the job.
     */
    public function resendReceipt(PosSale $sale): PosSale
    {
        /** @var Order $order */
        $order = Order::query()->whereKey($sale->order_id)->firstOrFail();
        if (trim($order->customer_phone) === '') {
            throw new ApiException(422, 'no_phone', 'This sale has no phone number to send a receipt to.');
        }
        // PHASE-8-9A §4.3: 402 only when neither the allowance nor the SMS credits cover the receipt.
        if (! app(SmsCharger::class)->canAfford(SmsPurposes::TRANSACTIONAL, self::receiptParts($order))) {
            FeatureGate::assertWithin($this->context->tenant(), Limit::SmsPerMonth);
        }
        DB::transaction(function () use ($order, $sale) {
            if (! $sale->sms_receipt) {
                PosSale::query()->whereKey($sale->id)->update(['sms_receipt' => true]);
            }
            self::queueReceipt($order, 'resend-'.strtolower((string) Str::ulid()));
        });

        return $sale->refresh();
    }

    /** SMS parts of the receipt as it would be sent now (store template + sender). */
    private static function receiptParts(Order $order): int
    {
        $store = Store::query()->with('primaryDomain')->findOrFail($order->store_id);
        $language = StoreSetting::query()->where('store_id', $store->id)->value('sms_language') === 'en' ? 'en' : 'bn';
        $vars = SmsTemplates::varsFor($order, $store) + PosReceipts::smsVars($order, $language);

        return SmsParts::partsOf(SmsTemplates::render(SmsTemplates::POS_RECEIPT, $language, $vars, $store));
    }

    private static function queueReceipt(Order $order, string $ref): void
    {
        SendOrderSms::dispatch($order->id, SmsTemplates::POS_RECEIPT, null, $ref)
            ->forTenant($order->tenant_id)->onQueue(OrderNotifier::QUEUE)->afterCommit();
    }
}
