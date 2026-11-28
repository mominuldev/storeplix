<?php

namespace App\Domain\Orders\Mail;

use App\Domain\Inbox\InboxEmail;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/**
 * Shopper confirmation (P5-26): store name as the From name, platform address, Reply-To = store contact email.
 * PHASE-8-8E P88E-15: with the email channel on, Reply-To = the signed order address `o-{order}-{sig}@…` instead, so a
 * reply lands in the Inbox with the order linked.
 */
class OrderPlacedMail extends Mailable
{
    public function __construct(
        public readonly Order $order,
        public readonly Store $store,
        public readonly ?string $storeEmail = null,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('orders@'.config('storeplix.platform_domain'), $this->store->name),
            replyTo: ($inbox = InboxEmail::orderReplyTo($this->order)) !== null
                ? [new Address($inbox, $this->store->name)]
                : ($this->storeEmail ? [new Address($this->storeEmail, $this->store->name)] : []),
            subject: "Your order {$this->order->number} at {$this->store->name}",
        );
    }

    public function content(): Content
    {
        $host = $this->store->primaryDomain?->hostname;

        return new Content(view: 'mail.orders.placed', with: [
            'order' => $this->order,
            'shop' => $this->store->name,
            'money' => fn (int $paisa) => Money::bdt($paisa),
            'trackUrl' => $host ? "https://{$host}/track" : null,
        ]);
    }
}
