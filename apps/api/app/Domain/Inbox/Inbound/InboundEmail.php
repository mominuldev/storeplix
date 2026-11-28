<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Inbound;

use Illuminate\Http\UploadedFile;

/**
 * What the provider already parsed (PHASE-8-8E §11.2): never the raw MIME, which is discarded. `authenticated` = the
 * provider reports SPF or DKIM pass; `auto` = Auto-Submitted ≠ no, Precedence bulk/junk/list, a mailer-daemon /
 * postmaster sender or the provider's spam flag (loop / bulk protection).
 */
final readonly class InboundEmail
{
    /**
     * @param  list<string>  $recipients  envelope recipient first, then To / Cc
     * @param  list<UploadedFile>  $attachments
     */
    public function __construct(
        public array $recipients,
        public string $from,
        public ?string $fromName,
        public string $subject,
        public string $text,
        public ?string $html,
        public ?string $messageId,
        public ?string $inReplyTo,
        public bool $authenticated,
        public bool $auto,
        public array $attachments,
    ) {}
}
