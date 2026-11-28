<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/**
 * Base of the support mails (PHASE-8-9C §10, S260): subject `[T-n] {subject}`, plain text + escaped HTML (Blade `{{ }}`),
 * a ≤ 300-character preview of a merchant / staff reply (never a note), a link to the app. Never attachments, never
 * order data. Every value is a plain string computed when the mail is queued (no tenant reads in the worker).
 */
abstract class SupportMail extends Mailable implements ShouldQueue
{
    use Queueable;

    public function __construct(
        public readonly string $reference,
        public readonly string $ticketSubject,
        public readonly string $shop,
        public readonly string $preview,
        public readonly string $url,
        public readonly string $actor = '',
        public readonly int $count = 1,
    ) {
        $this->onQueue('notifications');
    }

    abstract protected function headline(): string;

    abstract protected function cta(): string;

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('support@'.config('storeplix.platform_domain'), 'Store Plix support'),
            subject: "[{$this->reference}] {$this->ticketSubject}",
            tags: ['support'],
        );
    }

    public function content(): Content
    {
        $with = [
            'headline' => $this->headline(),
            'reference' => $this->reference,
            'ticketSubject' => $this->ticketSubject,
            'shop' => $this->shop,
            'preview' => $this->preview,
            'url' => $this->url,
            'cta' => $this->cta(),
        ];

        return new Content(view: 'mail.support.ticket', text: 'mail.support.ticket-text', with: $with);
    }
}
