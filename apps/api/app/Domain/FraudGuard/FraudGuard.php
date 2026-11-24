<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\Jobs\CheckOrderRisk;
use App\Domain\FraudGuard\Models\BlockedPhone;
use App\Domain\FraudGuard\Models\FraudGuardEvent;
use App\Domain\FraudGuard\Models\FraudGuardSetting;
use App\Domain\FraudGuard\Models\OrderRiskCheck;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The fake-order guard (PHASE-8-8 §5–§7). Own-shop data only (P88-1): every number comes from this store's rows.
 *
 * - onPlaced(): placement hook inside the placement transaction (P88-6) — `guard_hold = checking` for storefront COD
 *   orders of a guarded store; CheckOrderRisk is queued after commit for every new order (exchanges skipped).
 * - check(): the idempotent §5.2 algorithm (one check per order, S157) with the P88-5 decision matrix.
 * - assertNotHeld(): the §5.5 enforcement (409 `order_held`).
 * - linkPaid() / linkEnded(): the P5B-22 payment-link hooks (§5.3); release(): the merchant release.
 * - beforeCheckout(): blocklist, repeat returners, daily limit and OTP (§7) for storefront COD checkouts.
 * Call inside the tenant context.
 */
class FraudGuard
{
    public const CALL_FIRST = 'call_first';

    public const ADVANCE = 'advance';

    public const CHECKING = 'checking';

    public const HOLDS = [self::CALL_FIRST, self::ADVANCE, self::CHECKING];

    /** §5.4 reason codes. */
    public const REASONS = ['rate_below_hold', 'rate_below_advance', 'few_parcels', 'new_number', 'duplicate', 'blocked_number', 'no_gateway', 'otp_unavailable'];

    public function __construct(
        private readonly GuardSettings $settings,
        private readonly AuditLogger $audit,
        private readonly CheckoutOtpService $otp,
    ) {}

    // ------------------------------------------------------------------ placement (§5.1)

    /**
     * Inside the placement transaction. `$flags`: `otp_unavailable` (P88-13 fail-open) from beforeCheckout.
     *
     * @param  array<string, mixed>  $flags
     */
    public function onPlaced(Order $order, array $flags = []): void
    {
        if ($order->source_order_id !== null) {
            return; // exchanges are skipped (P88-6)
        }
        if ($order->created_via === 'storefront' && $order->payment_method === 'cod' && $order->status === Order::PENDING
            && $this->settings->guarded($order->store_id)) {
            $order->guard_hold = self::CHECKING;
            $order->guard_hold_at = now();
            $order->save();
            if (($flags['otp_unavailable'] ?? false) === true) {
                $this->event('otp_failed', $order->store_id, $order->customer_phone, $order->id, ['reason' => (string) ($flags['otp_reason'] ?? 'sms_unavailable')]);
            }
        }
        CheckOrderRisk::dispatch($order->id)->forTenant($order->tenant_id)->afterCommit();
    }

    // ------------------------------------------------------------------ check (§5.2)

    /** Idempotent: an order with a check is never checked again. Returns the new check, or null. */
    public function check(string $orderId): ?OrderRiskCheck
    {
        $result = DB::transaction(function () use ($orderId) {
            /** @var Order|null $o */
            $o = Order::query()->whereKey($orderId)->lockForUpdate()->first();
            if ($o === null || OrderRiskCheck::query()->where('order_id', $o->id)->exists()) {
                return null;
            }
            $phone = Phone::bdMsisdn($o->customer_phone) ?? $o->customer_phone;
            $settings = $this->settings->for($o->store_id);
            $record = ShopRecord::for($o->store_id, $phone, $o->id);
            $thresholds = $this->settings->thresholds($o->store_id);
            $tier = RiskTier::classify($record->delivered, $record->returned, $thresholds);
            $rate = $record->rate();

            $reasons = self::tierReasons($tier, $record, $thresholds);
            $withActions = $o->guard_hold === self::CHECKING && $o->status === Order::PENDING;
            $guarded = $this->settings->guarded($o->store_id);

            $duplicateOf = null;
            if ($o->created_via === 'storefront' && $guarded && $settings->duplicates_enabled) {
                $duplicateOf = $this->duplicateOf($o, $phone, (int) $settings->duplicate_window_hours);
            }
            if ($o->created_via !== 'storefront' && BlockedPhone::query()->where('store_id', $o->store_id)->where('phone', $phone)->active()->exists()) {
                $reasons[] = 'blocked_number'; // P88-9 / Q196: manual orders are allowed, badged
            }
            $otpUnavailable = FraudGuardEvent::query()->where('order_id', $o->id)->where('type', 'otp_failed')->exists();

            $decision = OrderRiskCheck::SKIPPED;
            $hold = null;
            $link = null;
            if ($withActions) {
                [$decision, $hold, $extra] = $this->decide($o, $settings, $tier, $duplicateOf, $otpUnavailable);
                $reasons = array_merge($reasons, $extra);
                if ($decision === OrderRiskCheck::ADVANCE) {
                    $link = $this->askAdvance($o, $settings);
                    if ($link === null) {
                        [$decision, $hold] = [OrderRiskCheck::HOLD, self::CALL_FIRST];
                        $reasons[] = 'no_gateway';
                    }
                }
            } else {
                if ($duplicateOf !== null) {
                    $reasons[] = 'duplicate';
                }
            }
            $reasons = array_values(array_unique($reasons));

            $check = new OrderRiskCheck;
            $check->store_id = $o->store_id;
            $check->order_id = $o->id;
            $check->phone = $phone;
            $check->tier = $tier;
            $check->rate = $rate;
            $check->delivered = $record->delivered;
            $check->total = $record->total();
            $check->shop_delivered = $record->delivered;
            $check->shop_total = $record->total();
            $check->reasons = $reasons;
            $check->decision = $decision;
            $check->with_actions = $withActions;
            $check->duplicate_of = $duplicateOf;
            $check->payment_link_id = $link?->id;
            $check->save();

            if ($withActions) {
                $o->guard_hold = $hold;
                $o->guard_hold_at = $hold !== null ? now() : null;
                $o->save();
                $meta = ['decision' => $decision, 'hold' => $hold, 'tier' => $tier, 'rate' => $rate, 'reasons' => $reasons,
                    'delivered' => $record->delivered, 'total' => $record->total()] + ($duplicateOf !== null ? ['duplicate_of' => $duplicateOf] : [])
                    + ($link !== null ? ['payment_link_id' => $link->id] : []);
                OrderTimeline::record($o, 'guard', null, self::timelineText($tier, $rate, $decision, $hold), $meta, null, null, 'system');
                $detail = ['tier' => $tier, 'rate' => $rate, 'delivered' => $record->delivered, 'total' => $record->total(), 'reasons' => $reasons];
                if ($decision === OrderRiskCheck::HOLD) {
                    $this->event($duplicateOf !== null ? 'duplicate' : 'held', $o->store_id, $phone, $o->id, $detail + ($duplicateOf !== null ? [
                        'duplicate_of' => $duplicateOf,
                        'duplicate_of_number' => Order::query()->whereKey($duplicateOf)->value('number'),
                        'window_hours' => (int) $settings->duplicate_window_hours,
                    ] : []));
                } elseif ($decision === OrderRiskCheck::ADVANCE) {
                    $this->event('advance_asked', $o->store_id, $phone, $o->id, $detail + ['amount' => (int) $link?->amount, 'payment_link_id' => $link?->id]);
                }
            } elseif ($o->guard_hold === self::CHECKING) {
                // §5.2 step 4: the order left `pending` (or the guard was switched off) before the check ran.
                $o->guard_hold = null;
                $o->guard_hold_at = null;
                $o->save();
            }

            return [$check, $guarded && (bool) $settings->block_returners && $record->returned >= (int) $settings->block_after_returns, $o];
        });
        if ($result === null) {
            return null;
        }
        [$check, $autoBlock, $order] = $result;
        if ($autoBlock) {
            $this->autoBlock($order->store_id, $check->phone);
        }

        return $check;
    }

    /**
     * P88-5 decision order (first match wins). The advance branch is resolved by the caller (link creation).
     *
     * @return array{0: string, 1: string|null, 2: list<string>} decision, hold, extra reasons
     */
    private function decide(Order $o, FraudGuardSetting $s, string $tier, ?string $duplicateOf, bool $otpUnavailable): array
    {
        if ($duplicateOf !== null) {
            return [OrderRiskCheck::HOLD, self::CALL_FIRST, ['duplicate']];
        }
        if ($otpUnavailable) {
            return [OrderRiskCheck::HOLD, self::CALL_FIRST, ['otp_unavailable']];
        }
        if ($tier === RiskTier::RISKY && $s->hold_enabled) {
            return [OrderRiskCheck::HOLD, self::CALL_FIRST, []];
        }
        if (($tier === RiskTier::RISKY || $tier === RiskTier::CAREFUL) && $s->advance_enabled) {
            if (PaymentService::usableProviders($o->store_id) === []) {
                return [OrderRiskCheck::HOLD, self::CALL_FIRST, ['no_gateway']];
            }

            return [OrderRiskCheck::ADVANCE, self::ADVANCE, []];
        }

        return [OrderRiskCheck::NONE, null, []];
    }

    /** §5.2 step 5: the delivery charge (or 25 % when there is none) through the existing payment link. */
    private function askAdvance(Order $o, FraudGuardSetting $s): ?PaymentLink
    {
        $provider = PaymentService::usableProviders($o->store_id)[0] ?? null;
        if ($provider === null) {
            return null;
        }
        $kind = $o->shipping_amount > 0 && $o->shipping_amount <= $o->dueAmount() ? 'delivery_charge' : 'percent';
        try {
            return app(PaymentLinkService::class)->create($o, [
                'amount_kind' => $kind,
                'percent_bps' => $kind === 'percent' ? 2500 : null,
                'provider' => $provider,
                'expires_in_minutes' => (int) $s->advance_expiry_minutes,
                'cancel_if_unpaid' => (bool) $s->advance_cancel_if_unpaid,
                'send_sms' => true,
            ], null);
        } catch (Throwable $e) {
            Log::warning('fraud_guard.advance_failed', ['order_id' => $o->id, 'error' => $e::class]);

            return null;
        }
    }

    /** @param array{hold_below: int, advance_below: int, min_parcels: int} $t @return list<string> */
    private static function tierReasons(string $tier, ShopRecord $record, array $t): array
    {
        return match (true) {
            $tier === RiskTier::NEW_NUMBER => ['new_number'],
            $record->total() < $t['min_parcels'] => ['few_parcels'],
            $tier === RiskTier::RISKY => ['rate_below_hold'],
            $tier === RiskTier::CAREFUL => ['rate_below_advance'],
            default => [],
        };
    }

    private static function timelineText(string $tier, ?int $rate, string $decision, ?string $hold): string
    {
        $label = ucfirst($tier).($rate !== null ? " ({$rate}% delivered)" : '');

        return 'Fraud check: '.$label.match (true) {
            $hold === self::CALL_FIRST => ' — held for a call',
            $decision === OrderRiskCheck::ADVANCE => ' — advance asked',
            default => ' — no action',
        };
    }

    /** P88-12: another non-cancelled order of this phone in the window with the same variant. */
    private function duplicateOf(Order $o, string $phone, int $hours): ?string
    {
        $variants = DB::table('order_items')->where('order_id', $o->id)->whereNotNull('variant_id')->pluck('variant_id')->all();
        if ($variants === []) {
            return null;
        }
        $from = $o->placed_at->copy()->subHours($hours);

        return Order::query()->where('store_id', $o->store_id)->where('customer_phone', $phone)->whereKeyNot($o->id)
            ->where('status', '<>', Order::CANCELLED)->where('placed_at', '>=', $from)->where('placed_at', '<=', $o->placed_at)
            ->whereExists(fn ($q) => $q->selectRaw('1')->from('order_items')->whereColumn('order_items.order_id', 'orders.id')->whereIn('order_items.variant_id', $variants))
            ->orderByDesc('placed_at')->orderByDesc('id')->value('id');
    }

    // ------------------------------------------------------------------ enforcement (§5.5)

    public static function assertNotHeld(Order $order): void
    {
        $hold = $order->guard_hold;
        if ($hold === null) {
            return;
        }
        throw new ApiException(409, 'order_held', match ($hold) {
            self::ADVANCE => 'This order is waiting for the advance payment. Release the hold to confirm it without the advance.',
            self::CHECKING => 'This order is still being checked. Try again in a moment.',
            default => 'This order is on hold for a call. Release the hold first.',
        }, ['hold' => $hold]);
    }

    // ------------------------------------------------------------------ releases (§5.3)

    /** POST …/orders/{order}/guard/release (orders.process). */
    public function release(Order $order, ?User $user): Order
    {
        $released = DB::transaction(function () use ($order, $user) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($o->guard_hold === null) {
                throw new ApiException(409, 'order_not_held', 'This order isn’t on hold.');
            }
            $from = $o->guard_hold;
            $o->guard_hold = null;
            $o->guard_hold_at = null;
            $o->save();
            $check = OrderRiskCheck::query()->where('order_id', $o->id)->first();
            if ($check !== null) {
                $check->released_at = now();
                $check->released_by = $user?->getKey();
                $check->save();
            }
            OrderTimeline::record($o, 'guard', $user, 'Hold released', ['action' => 'released', 'released' => true, 'hold' => $from]);
            $this->event('released', $o->store_id, $o->customer_phone, $o->id, ['hold' => $from, 'by_name' => $user?->name]);
            $this->audit->log('fraud.hold_released', $o, ['hold' => $from], $user);

            // "Confirm without advance": the guard's open advance link goes with the hold (its cancel-if-unpaid would
            // otherwise cancel the confirmed order at expiry).
            return [$o, $from === self::ADVANCE ? $check?->payment_link_id : null];
        });
        [$o, $linkId] = $released;
        if ($linkId !== null) {
            $link = PaymentLink::query()->whereKey($linkId)->where('status', PaymentLink::ACTIVE)->first();
            if ($link !== null) {
                app(PaymentLinkService::class)->cancel($link, $user);
            }
        }

        return $o;
    }

    /** P5B-22 paid link (PaymentService::markPaid, order row locked): a paid link releases the hold; the link flow confirms. */
    public function linkPaid(Order $o, PaymentLink $link, bool $confirms): void
    {
        $hold = $o->guard_hold;
        if ($hold === null || (! $confirms && $hold !== self::ADVANCE)) {
            return;
        }
        $o->guard_hold = null;
        $o->guard_hold_at = null;
        $check = OrderRiskCheck::query()->where('order_id', $o->id)->first();
        if ($check !== null && $check->released_at === null) {
            $check->released_at = now();
            $check->save();
        }
        if ($hold === self::ADVANCE || $check?->payment_link_id === $link->id) {
            $this->event('advance_paid', $o->store_id, $o->customer_phone, $o->id, ['amount' => (int) $link->amount, 'payment_link_id' => $link->id]);
        }
    }

    /** P5B-22 link expired (not cancelling the order) or cancelled by the merchant: back to `call_first` (§5.3). */
    public function linkEnded(Order $o): void
    {
        if ($o->guard_hold !== self::ADVANCE) {
            return;
        }
        $o->guard_hold = self::CALL_FIRST;
        $o->guard_hold_at = now();
        $o->save();
        OrderTimeline::record($o, 'guard', null, 'Advance not paid — held for a call', ['action' => 'advance_ended', 'hold' => self::CALL_FIRST], null, null, 'system');
    }

    // ------------------------------------------------------------------ blocklist (§6.2, P88-10)

    /** P88-10: one automatic block per phone, never after a merchant unblock or while a manual block is active. */
    public function autoBlock(string $storeId, string $phone): ?BlockedPhone
    {
        $phone = Phone::bdMsisdn($phone) ?? $phone;

        return DB::transaction(function () use ($storeId, $phone) {
            $seen = BlockedPhone::query()->where('store_id', $storeId)->where('phone', $phone)
                ->where(fn ($q) => $q->whereNull('unblocked_at')->orWhere('reason', BlockedPhone::REPEAT_RETURNS))->exists();
            if ($seen) {
                return null;
            }
            $record = ShopRecord::for($storeId, $phone);
            $row = new BlockedPhone;
            $row->store_id = $storeId;
            $row->phone = $phone;
            $row->customer_id = Customer::query()->where('store_id', $storeId)->where('phone', $phone)->value('id');
            $row->reason = BlockedPhone::REPEAT_RETURNS;
            $row->source = BlockedPhone::AUTO;
            try {
                DB::transaction(fn () => $row->save());
            } catch (UniqueConstraintViolationException) {
                return null; // a parallel block won
            }
            $this->event('auto_blocked', $storeId, $phone, null, ['returned_count' => $record->returned, 'rule' => 'repeat_returns']);

            return $row;
        });
    }

    /** After a return (OrderService::return, courier returned): the repeat-returner rule for a guarded store. */
    public function afterReturned(Order $o): void
    {
        $storeId = $o->store_id;
        $phone = $o->customer_phone;
        DB::afterCommit(function () use ($storeId, $phone) {
            $s = $this->settings->for($storeId);
            if (! $this->settings->guarded($storeId) || ! $s->block_returners) {
                return;
            }
            if (ShopRecord::for($storeId, $phone)->returned >= (int) $s->block_after_returns) {
                $this->autoBlock($storeId, $phone);
            }
        });
    }

    // ------------------------------------------------------------------ checkout rules (§7)

    /**
     * Storefront checkout, before stock is reserved: blocked / repeat-returner → 422 `cod_unavailable`; over the daily
     * limit → 422 `order_limit_reached`; a new number → OTP (`otp_required` / `otp_invalid`), failing open when SMS is
     * unavailable. Online payments pass untouched. Returns placement flags.
     *
     * @return array<string, mixed>
     */
    public function beforeCheckout(Store $store, string $phone, string $method, ?string $otpCode): array
    {
        if ($method !== 'cod' || ! $this->settings->guarded($store->id)) {
            return [];
        }
        $s = $this->settings->for($store->id);
        $phone = Phone::bdMsisdn($phone) ?? $phone;

        $blocked = BlockedPhone::query()->where('store_id', $store->id)->where('phone', $phone)->active()->exists();
        if (! $blocked && $s->block_returners && ShopRecord::for($store->id, $phone)->returned >= (int) $s->block_after_returns) {
            $blocked = $this->autoBlock($store->id, $phone) !== null;
        }
        if ($blocked) {
            $this->event('blocked_checkout', $store->id, $phone, null, []);
            $message = "Cash on delivery isn't available for this number. Please pay online.";
            throw new ApiException(422, 'cod_unavailable', $message, ['payment_method' => [$message]]);
        }

        if ($s->daily_limit_enabled) {
            $dayStart = now($store->timezone ?: 'Asia/Dhaka')->startOfDay()->utc();
            $today = Order::query()->where('store_id', $store->id)->where('customer_phone', $phone)->where('created_via', 'storefront')
                ->where('payment_method', 'cod')->where('placed_at', '>=', $dayStart)->count();
            if ($today >= (int) $s->daily_limit) {
                $this->event('limit_reached', $store->id, $phone, null, ['count' => $today, 'limit' => (int) $s->daily_limit]);
                $message = "You've reached today's order limit for cash on delivery. Please pay online or try tomorrow.";
                throw new ApiException(422, 'order_limit_reached', $message, ['payment_method' => [$message]]);
            }
        }

        if ($s->otp_enabled && self::isNewNumber($store->id, $phone)) {
            $unavailable = $this->otp->unavailableReason($store, $phone);
            if ($unavailable !== null) {
                return ['otp_unavailable' => true, 'otp_reason' => $unavailable];
            }
            $this->otp->assertVerified($store, $phone, $otpCode);
        }

        return [];
    }

    /** P88-13: new to this store = no customer with ≥ 1 delivered order. */
    public static function isNewNumber(string $storeId, string $phone): bool
    {
        return ! Customer::query()->where('store_id', $storeId)->where('phone', $phone)->where('delivered_orders_count', '>=', 1)->exists();
    }

    // ------------------------------------------------------------------ log

    /** @param array<string, mixed> $detail never a raw phone (P88-16) */
    public function event(string $type, string $storeId, string $phone, ?string $orderId, array $detail): FraudGuardEvent
    {
        $event = new FraudGuardEvent;
        $event->store_id = $storeId;
        $event->type = $type;
        $event->order_id = $orderId;
        $event->phone = Phone::bdMsisdn($phone) ?? mb_substr($phone, 0, 13);
        $event->detail = $detail;
        $event->created_at = now();
        $event->save();

        return $event;
    }

    /** "01712•••678" (types: BlockedNumber.phone_masked). */
    public static function mask(string $phone): string
    {
        $msisdn = Phone::bdMsisdn($phone);
        $local = $msisdn !== null ? '0'.substr($msisdn, 3) : $phone;
        if (strlen($local) < 8) {
            return str_repeat('•', strlen($local));
        }

        return substr($local, 0, 5).'•••'.substr($local, -3);
    }
}
