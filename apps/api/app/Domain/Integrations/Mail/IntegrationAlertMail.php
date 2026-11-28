<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Mail;

use App\Domain\Integrations\IntegrationProvider;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/**
 * PHASE-8-9D P89D-16 / §4.4: an integration stopped working (owner + admins, once per transition into `error`). Plain
 * values only — never a token, provider text or customer data.
 */
class IntegrationAlertMail extends Mailable implements ShouldQueue
{
    use Queueable;

    public function __construct(
        public readonly string $provider,
        public readonly string $reason,
        public readonly string $shop,
    ) {
        $this->onQueue('notifications');
    }

    public function envelope(): Envelope
    {
        $label = IntegrationProvider::LABELS[$this->provider] ?? $this->provider;
        $subject = $this->reason === 'token_expired' ? "Reconnect {$label}: access expired" : "Your {$label} access token stopped working";

        return new Envelope(from: new Address('alerts@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.integrations.alert', with: [
            'label' => IntegrationProvider::LABELS[$this->provider] ?? $this->provider,
            'reason' => $this->reason,
            'shop' => $this->shop,
            'feed' => IntegrationProvider::isFeed($this->provider),
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/integrations/'.self::route($this->provider),
        ]);
    }

    /** Merchant app routes (§8). */
    public static function route(string $provider): string
    {
        return match ($provider) {
            IntegrationProvider::META_PIXEL => 'meta-pixel',
            IntegrationProvider::TIKTOK_PIXEL => 'tiktok',
            IntegrationProvider::GTM_SERVER => 'gtm',
            IntegrationProvider::META_CATALOG => 'meta-catalog',
            IntegrationProvider::GOOGLE_MERCHANT => 'google-merchant',
            IntegrationProvider::AI_WRITER => 'claude',
            IntegrationProvider::AI_PHOTOS => 'ai-photos',
            default => $provider,
        };
    }
}
