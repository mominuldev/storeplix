<?php

namespace App\Domain\Staff\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

class StaffInvitationMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public function __construct(
        public readonly string $token,
        public readonly string $shopName,
        public readonly string $inviterName,
        public readonly string $role,
        public readonly ?string $roleName = null, // Phase 8.3: the role's display name (custom roles)
    ) {}

    public function url(): string
    {
        return rtrim((string) config('storeplix.merchant_app_url'), '/').'/invite?token='.rawurlencode($this->token);
    }

    public function envelope(): Envelope
    {
        return new Envelope(subject: "You're invited to {$this->shopName} on Store Plix");
    }

    public function content(): Content
    {
        return new Content(view: 'mail.staff-invitation', with: [
            'url' => $this->url(),
            'shop' => $this->shopName,
            'inviter' => $this->inviterName,
            'roleLabel' => $this->roleName ?? ($this->role === 'admin' ? 'Manager' : 'Staff'),
        ]);
    }
}
