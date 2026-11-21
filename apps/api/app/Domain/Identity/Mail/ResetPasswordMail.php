<?php

namespace App\Domain\Identity\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

class ResetPasswordMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public function __construct(public readonly string $email, public readonly string $token) {}

    public function url(): string
    {
        return rtrim((string) config('storeplix.merchant_app_url'), '/')
            .'/reset-password?token='.rawurlencode($this->token).'&email='.rawurlencode($this->email);
    }

    public function envelope(): Envelope
    {
        return new Envelope(subject: 'Reset your Store Plix password');
    }

    public function content(): Content
    {
        return new Content(view: 'mail.reset-password', with: ['url' => $this->url(), 'minutes' => 60]);
    }
}
