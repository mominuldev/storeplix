<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Mail;

use App\Domain\Admin\Authorization\PlatformRole;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/** PHASE-8-1 P8-16: staff invitation, link `{ADMIN_APP_URL}/accept-invite#token=…` (fragment: never sent to a server). */
class PlatformInvitationMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public function __construct(
        public readonly string $token,
        public readonly string $inviterName,
        public readonly string $role,
    ) {}

    public function url(): string
    {
        return rtrim((string) config('admin.app_url'), '/').'/accept-invite#token='.rawurlencode($this->token);
    }

    public function envelope(): Envelope
    {
        return new Envelope(subject: "You're invited to Store Plix admin");
    }

    public function content(): Content
    {
        return new Content(view: 'mail.platform-invitation', with: [
            'url' => $this->url(),
            'inviter' => $this->inviterName,
            'roleLabel' => self::roleLabel($this->role),
        ]);
    }

    public static function roleLabel(string $role): string
    {
        return match (PlatformRole::tryFrom($role)) {
            PlatformRole::SuperAdmin => 'Super admin',
            PlatformRole::Billing => 'Billing',
            PlatformRole::Support => 'Support',
            PlatformRole::ReadOnly => 'Read only',
            null => $role,
        };
    }
}
