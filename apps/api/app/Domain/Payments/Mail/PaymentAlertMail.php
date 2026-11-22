<?php

declare(strict_types=1);

namespace App\Domain\Payments\Mail;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Jobs\SendPaymentAlert;
use App\Domain\Payments\PaymentService;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/** Merchant payment alerts (P5B-16 mismatch, P5B-21 late payment refunded, P5B-25 refund failed). No shopper PII. */
class PaymentAlertMail extends Mailable
{
    public function __construct(
        public readonly string $kind,
        public readonly Order $order,
        public readonly Payment $payment,
        public readonly Store $store,
        public readonly ?string $refundStatus = null,
    ) {}

    public function envelope(): Envelope
    {
        $subject = match ($this->kind) {
            SendPaymentAlert::MISMATCH => "Payment not accepted for order {$this->order->number}",
            SendPaymentAlert::LATE_REFUND => "Paid after the order expired — refunded · {$this->order->number}",
            default => "Refund failed for order {$this->order->number}",
        };

        return new Envelope(from: new Address('orders@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.payments.alert', with: [
            'kind' => $this->kind,
            'order' => $this->order,
            'shop' => $this->store->name,
            'amount' => Money::bdt((int) $this->payment->amount),
            'gateway' => PaymentService::providerLabel($this->payment->provider),
            'failureCode' => $this->payment->failure_code,
            'refundStatus' => $this->refundStatus,
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/orders/'.$this->order->id,
        ]);
    }
}
