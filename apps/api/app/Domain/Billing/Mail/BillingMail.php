<?php

declare(strict_types=1);

namespace App\Domain\Billing\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/** P7-21: billing emails to the shop owner (queued on `notifications`, mail tag `billing`) and the ops alerts (P7-14). */
final class BillingMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public const TRIAL_ENDING = 'trial_ending';

    public const INVOICE_ISSUED = 'invoice_issued';

    public const REMINDER = 'reminder';

    public const PAYMENT_RECEIVED = 'payment_received';

    public const PAST_DUE = 'past_due';

    public const GRACE_ENDING = 'grace_ending';

    public const DROPPED_TO_FREE = 'dropped_to_free';

    public const DOMAIN_WILL_DETACH = 'domain_will_detach';

    public const OPS_ALERT = 'ops_alert';

    public const KINDS = [self::TRIAL_ENDING, self::INVOICE_ISSUED, self::REMINDER, self::PAYMENT_RECEIVED, self::PAST_DUE,
        self::GRACE_ENDING, self::DROPPED_TO_FREE, self::DOMAIN_WILL_DETACH, self::OPS_ALERT];

    /** @param array<string, string|int|null> $data plain, already formatted strings (escaped by Blade) */
    public function __construct(
        public readonly string $kind,
        public readonly string $shop,
        public readonly array $data = [],
    ) {
        $this->onQueue('notifications');
        $this->tag('billing');
    }

    public function envelope(): Envelope
    {
        $plan = (string) ($this->data['plan'] ?? 'your');
        $subject = match ($this->kind) {
            self::TRIAL_ENDING => "Your free trial ends on {$this->data['date']}",
            self::INVOICE_ISSUED => "Invoice {$this->data['number']}: your {$plan} plan renews on {$this->data['date']}",
            self::REMINDER => "Reminder: your {$plan} plan renews on {$this->data['date']}",
            self::PAYMENT_RECEIVED => "Payment received: {$this->data['number']}",
            self::PAST_DUE => "Payment failed for your {$plan} plan",
            self::GRACE_ENDING => "Pay by {$this->data['date']} to keep your {$plan} plan",
            self::DROPPED_TO_FREE => 'Your shop is now on the Free plan',
            self::DOMAIN_WILL_DETACH => "Your custom domain stops working on {$this->data['date']}",
            default => "Billing alert: {$this->data['event']}",
        };

        return new Envelope(from: new Address('billing@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject, tags: ['billing']);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.billing.notice', with: [
            'kind' => $this->kind,
            'shop' => $this->shop,
            'data' => $this->data,
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/settings/plan',
        ]);
    }
}
