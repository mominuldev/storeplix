<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Mail;

use Illuminate\Mail\Attachment;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Mail\Mailables\Headers;

/**
 * A shop reply to an email conversation (PHASE-8-8E P88E-16): From `"{Shop}" <inbox@{platform}>`, Reply-To the signed
 * conversation address, `Re: {subject}`, In-Reply-To / References from the last inbound Message-ID, plain text and
 * escaped HTML (shop URLs autolinked with rel nofollow noopener noreferrer), attachments attached. Sent synchronously
 * by SendInboxEmailReply (which owns the retries).
 */
final class InboxReplyMail extends Mailable
{
    /** @param list<array{data: string, name: string, mime: string}> $files */
    public function __construct(
        public readonly string $shop,
        public readonly string $replyAddress,
        public readonly string $subjectLine,
        public readonly string $body,
        public readonly ?string $inReplyTo,
        public readonly array $files = [],
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address('inbox@'.config('storeplix.platform_domain'), $this->shop),
            replyTo: [new Address($this->replyAddress, $this->shop)],
            subject: $this->subjectLine,
            tags: ['inbox'],
        );
    }

    public function headers(): Headers
    {
        $ref = $this->inReplyTo !== null ? trim($this->inReplyTo, '<>') : null;

        return new Headers(references: $ref !== null ? [$ref] : [], text: $ref !== null ? ['In-Reply-To' => '<'.$ref.'>'] : []);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.inbox.reply', text: 'mail.inbox.reply-text', with: [
            'shop' => $this->shop,
            'body' => $this->body,
            'html' => self::autolink($this->body),
        ]);
    }

    /** @return list<Attachment> */
    public function attachments(): array
    {
        return array_map(fn (array $f) => Attachment::fromData(fn () => $f['data'], $f['name'])->withMime($f['mime']), $this->files);
    }

    /** Escaped text with http(s) URLs as links (shop replies only, P88E-23) and line breaks. */
    public static function autolink(string $text): string
    {
        $escaped = e($text);
        $linked = (string) preg_replace_callback('~\bhttps?://[^\s<>"\']+~i', function (array $m) {
            $url = rtrim($m[0], '.,);:!?');
            $tail = substr($m[0], strlen($url));

            return '<a href="'.$url.'" rel="nofollow noopener noreferrer">'.$url.'</a>'.$tail;
        }, $escaped);

        return nl2br($linked, false);
    }
}
