<?php

namespace App\Domain\Orders\Mail;

use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/** Merchant alert for every new order (P5-26, toggle notify_new_order_email). */
class NewOrderMerchantMail extends Mailable
{
    public function __construct(
        public readonly Order $order,
        public readonly Store $store,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('orders@'.config('storeplix.platform_domain'), 'Store Plix'),
            subject: "New order {$this->order->number} · Tk ".Money::plain($this->order->total_amount),
        );
    }

    public function content(): Content
    {
        return new Content(view: 'mail.orders.merchant-new', with: [
            'order' => $this->order,
            'shop' => $this->store->name,
            'money' => fn (int $paisa) => Money::bdt($paisa),
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/orders/'.$this->order->id,
        ]);
    }
}
