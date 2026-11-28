<?php

declare(strict_types=1);

namespace App\Domain\Sms\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * PHASE-8-9A emails (queued on `notifications`, tag `sms`): low SMS credits (§5.6) and the sender-ID review outcomes
 * to the shop owner (§8.2, §8.3), plus the "new sender ID request" note to platform ops.
 */
final class SmsMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public const LOW_CREDITS = 'low_credits';

    public const SENDER_ID_REQUESTED = 'sender_id_requested';

    public const SENDER_ID_REQUESTED_OPS = 'sender_id_requested_ops';

    public const SENDER_ID_APPROVED = 'sender_id_approved';

    public const SENDER_ID_REJECTED = 'sender_id_rejected';

    public const SENDER_ID_REVOKED = 'sender_id_revoked';

    public const KINDS = [self::LOW_CREDITS, self::SENDER_ID_REQUESTED, self::SENDER_ID_REQUESTED_OPS, self::SENDER_ID_APPROVED,
        self::SENDER_ID_REJECTED, self::SENDER_ID_REVOKED];

    /** @param array<string, string|int|null> $data plain strings (escaped by Blade) */
    public function __construct(
        public readonly string $kind,
        public readonly string $shop,
        public readonly array $data = [],
    ) {
        $this->onQueue('notifications');
        $this->tag('sms');
    }

    public function envelope(): Envelope
    {
        $id = (string) ($this->data['sender_id'] ?? '');
        $subject = match ($this->kind) {
            self::LOW_CREDITS => "{$this->data['balance']} SMS credits left — buy more before messages stop",
            self::SENDER_ID_REQUESTED, self::SENDER_ID_REQUESTED_OPS => "New sender ID request: {$id}",
            self::SENDER_ID_APPROVED => "Your sender ID {$id} is live",
            self::SENDER_ID_REJECTED => "Your sender ID request {$id} was not approved",
            default => "Your sender ID {$id} was turned off",
        };

        return new Envelope(from: new Address('sms@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject, tags: ['sms']);
    }

    public function content(): Content
    {
        $tab = $this->kind === self::LOW_CREDITS ? 'credits' : 'sender-id';

        return new Content(view: 'mail.sms.notice', with: [
            'kind' => $this->kind,
            'shop' => $this->shop,
            'data' => $this->data,
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/integrations/sms?tab='.$tab,
        ]);
    }
}
