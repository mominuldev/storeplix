<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/**
 * "{actor} assigned you a conversation" (PHASE-8-8E P88E-4, S245): no attachments, a ≤ 160-character preview of the
 * last shopper / reply text (never a note), a link to the conversation. Queued on `notifications`.
 */
final class InboxAssignedMail extends Mailable implements ShouldQueue
{
    use Queueable;

    public function __construct(
        public readonly string $shop,
        public readonly string $actor,
        public readonly string $contact,
        public readonly string $preview,
        public readonly string $conversationId,
    ) {
        $this->onQueue('notifications');
    }

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('inbox@'.config('storeplix.platform_domain'), 'Store Plix'),
            subject: "{$this->actor} assigned you a conversation with {$this->contact}",
            tags: ['inbox'],
        );
    }

    public function content(): Content
    {
        return new Content(view: 'mail.inbox.assigned', with: [
            'shop' => $this->shop,
            'actor' => $this->actor,
            'contact' => $this->contact,
            'preview' => $this->preview,
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/inbox/'.$this->conversationId,
        ]);
    }
}
