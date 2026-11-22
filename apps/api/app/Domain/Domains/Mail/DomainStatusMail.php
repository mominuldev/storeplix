<?php

declare(strict_types=1);

namespace App\Domain\Domains\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/**
 * P6-19 merchant emails (owner only, queued on `notifications`). Plain values only: no tenant data is read when the
 * worker sends it, and never the verification token.
 */
class DomainStatusMail extends Mailable implements ShouldQueue
{
    use Queueable;

    public const LIVE = 'live';

    public const DNS_MISSING = 'dns_missing';

    public const FAILED = 'failed';

    public const EXPIRED = 'expired';

    public const PRIMARY_FALLBACK = 'primary_fallback';

    public const RELEASED = 'released';

    public const KINDS = [self::LIVE, self::DNS_MISSING, self::FAILED, self::EXPIRED, self::PRIMARY_FALLBACK, self::RELEASED];

    public function __construct(
        public readonly string $kind,
        public readonly string $hostname,
        public readonly string $shop,
        public readonly ?string $detail = null,
        public readonly ?string $fallbackHost = null,
    ) {
        $this->onQueue('notifications');
    }

    public function envelope(): Envelope
    {
        $subject = match ($this->kind) {
            self::LIVE => "{$this->hostname} is live",
            self::DNS_MISSING => "Action needed: DNS records for {$this->hostname} are missing",
            self::FAILED => "We couldn't connect {$this->hostname}",
            self::EXPIRED => "{$this->hostname} was disconnected",
            self::PRIMARY_FALLBACK => "Your shop is back on {$this->fallbackHost}",
            default => "{$this->hostname} was released",
        };

        return new Envelope(from: new Address('domains@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.domains.status', with: [
            'kind' => $this->kind,
            'hostname' => $this->hostname,
            'shop' => $this->shop,
            'detail' => $this->detail,
            'fallbackHost' => $this->fallbackHost,
            'days' => (int) config('domains.expire_after_days', 7),
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/online-store/domains',
        ]);
    }
}
