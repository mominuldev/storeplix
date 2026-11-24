<?php

declare(strict_types=1);

namespace App\Domain\Automations\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * Low-stock team email (P86-19, §6 notify_team): "Low stock: {product} · {variant} — {on_hand} left" with a dashboard
 * link. Transactional (not marketing): no allowance, no opt-out footer, no customer data (S138). Rendered from plain
 * strings, so the queued copy needs no tenant context.
 */
class LowStockMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        public readonly string $shop,
        public readonly string $product,
        public readonly ?string $variant,
        public readonly int $onHand,
        public readonly string $url,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('alerts@'.config('storeplix.platform_domain'), 'Store Plix'),
            subject: self::oneLine('Low stock: '.$this->item().' — '.$this->onHand.' left'),
        );
    }

    public function content(): Content
    {
        $e = fn (string $v) => htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
        $html = '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">'
            .'<p><strong>'.$e($this->item()).'</strong> is running low at '.$e($this->shop).': '.$this->onHand.' left.</p>'
            .'<p><a href="'.$e($this->url).'">Open the product in your dashboard</a></p>'
            .'<p style="color:#6e6e73;font-size:12px">Sent by your "Low stock alert" automation.</p></body></html>';

        return new Content(htmlString: $html);
    }

    public function item(): string
    {
        return $this->variant !== null ? $this->product.' · '.$this->variant : $this->product;
    }

    private static function oneLine(string $value): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value)));
    }
}
