<?php

declare(strict_types=1);

namespace App\Domain\Sms\Mail;

use App\Domain\Identity\Models\User;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Mail;

/**
 * PHASE-8-9B §4.7, P89B-8: platform SMS alerts to every active super admin — gateway balance below the threshold (once per
 * crossing) and "SMS failover started". Never carries a credential; plain strings only.
 */
final class PlatformSmsMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public const LOW_BALANCE = 'low_balance';

    public const FAILOVER_STARTED = 'failover_started';

    /** @param array<string, string|int|null> $data */
    public function __construct(public readonly string $kind, public readonly array $data = [])
    {
        $this->onQueue('notifications');
        $this->tag('platform-sms');
    }

    /** Queues the mail to every active super admin. Returns the number of recipients. */
    public static function toSuperAdmins(string $kind, array $data): int
    {
        $emails = User::query()->where('platform_role', 'super_admin')->whereNull('platform_disabled_at')->whereNotNull('email')->pluck('email');
        foreach ($emails as $email) {
            Mail::to((string) $email)->send(new self($kind, $data));
        }

        return $emails->count();
    }

    public function envelope(): Envelope
    {
        $name = (string) ($this->data['provider'] ?? 'SMS provider');
        $subject = $this->kind === self::LOW_BALANCE
            ? "{$name} balance is low ({$this->data['balance']})"
            : "SMS failover started: {$name} is failing";

        return new Envelope(from: new Address('sms@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject, tags: ['platform-sms']);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.platform-sms.notice', with: [
            'kind' => $this->kind,
            'data' => $this->data,
            'url' => rtrim((string) config('admin.app_url'), '/').'/settings/sms?tab=provider',
        ]);
    }
}
