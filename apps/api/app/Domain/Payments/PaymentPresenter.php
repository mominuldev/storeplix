<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Support\Facades\Crypt;
use Throwable;

/** 5b-2 payloads (@storeplix/types): PaymentInitiation, StorefrontPaymentState/Result, PaymentLink, PaymentLinkView. */
final class PaymentPresenter
{
    /** @return array{payment_id: string, provider: string, status: string, redirect_url: string|null, amount: int, expires_at: string|null} */
    public static function initiation(Payment $payment, string $status, ?string $redirectUrl): array
    {
        return [
            'payment_id' => $payment->id,
            'provider' => $payment->provider,
            'status' => $status,
            'redirect_url' => $redirectUrl,
            'amount' => (int) $payment->amount,
            'expires_at' => UserRef::iso($payment->expires_at),
        ];
    }

    /**
     * StorefrontOrder.payment: the latest online attempt for the order itself (purpose order|advance), or null for a
     * plain COD order. Links are paid on /pay/{token}, not from the thank-you page.
     *
     * @return array<string, mixed>|null
     */
    public static function storefrontState(Order $order, ?StoreSetting $settings = null): ?array
    {
        $latest = Payment::query()->where('order_id', $order->id)->where('type', Payment::TYPE_CHARGE)
            ->whereIn('provider', Payment::ONLINE_PROVIDERS)->whereIn('purpose', [Payment::PURPOSE_ORDER, Payment::PURPOSE_ADVANCE])
            ->orderByDesc('created_at')->orderByDesc('id')->first();
        if ($latest === null) {
            return null;
        }
        $settings ??= StoreSetting::query()->where('store_id', $order->store_id)->first();
        $open = $order->status === Order::PENDING_PAYMENT && $order->payment_expires_at?->isFuture() === true;
        $cod = $open && (bool) ($settings?->cod_enabled ?? true) && $latest->purpose !== Payment::PURPOSE_ADVANCE
            && ! PaymentService::advanceRequired($settings, $order->shipping_amount);

        return [
            'status' => $latest->status,
            'provider' => $latest->provider,
            'purpose' => $latest->purpose,
            'amount' => (int) $latest->amount,
            'expires_at' => $order->status === Order::PENDING_PAYMENT ? UserRef::iso($order->payment_expires_at) : null,
            'can_retry' => $open && $latest->status !== Payment::STATUS_SUCCEEDED,
            'can_switch_to_cod' => $cod,
        ];
    }

    /** @return array<string, mixed> StorefrontPaymentResult (no PII) */
    public static function storefrontResult(Payment $payment, Store $store): array
    {
        $number = $payment->order_id !== null ? (string) Order::query()->whereKey($payment->order_id)->value('number') : '';

        return [
            'status' => $payment->status,
            'order_number' => $number,
            'amount' => (int) $payment->amount,
            'currency' => $payment->currency,
            'purpose' => $payment->purpose,
            'shop_name' => $store->name,
        ];
    }

    /** @return array<string, mixed> PaymentLink */
    public static function link(PaymentLink $link, Store $store): array
    {
        return [
            'id' => $link->id,
            'order_id' => $link->order_id,
            'amount_kind' => $link->amount_kind,
            'percent_bps' => $link->percent_bps,
            'amount' => (int) $link->amount,
            'currency' => 'BDT',
            'provider' => $link->provider,
            'status' => self::linkStatus($link),
            'url' => PaymentUrls::linkUrl($store, self::linkToken($link)),
            'expires_at' => UserRef::iso($link->expires_at),
            'cancel_if_unpaid' => (bool) $link->cancel_if_unpaid,
            'sent_via' => array_values(array_unique(array_filter((array) $link->sent_via, fn ($v) => $v === 'sms'))),
            'paid_at' => UserRef::iso($link->paid_at),
            'created_by' => UserRef::of($link->relationLoaded('creator') ? $link->creator : $link->creator()->first()),
            'created_at' => UserRef::iso($link->created_at),
        ];
    }

    /** @return array<string, mixed> PaymentLinkView (no PII) */
    public static function linkView(PaymentLink $link, Order $order, Store $store): array
    {
        return [
            'order_number' => $order->number,
            'shop_name' => $store->name,
            'amount' => (int) $link->amount,
            'currency' => 'BDT',
            'provider' => $link->provider,
            'expires_at' => UserRef::iso($link->expires_at),
            'status' => 'active',
        ];
    }

    /** An active link past its expiry reads as expired before payment-links:expire catches up. */
    public static function linkStatus(PaymentLink $link): string
    {
        return $link->status === PaymentLink::ACTIVE && ! $link->expires_at->isFuture() ? PaymentLink::EXPIRED : $link->status;
    }

    public static function linkToken(PaymentLink $link): string
    {
        try {
            return Crypt::decryptString($link->token_encrypted);
        } catch (Throwable) {
            return '';
        }
    }
}
