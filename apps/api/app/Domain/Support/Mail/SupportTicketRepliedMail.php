<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

/** To the requester (owner fallback): Store Plix support replied (never for a note; coalesced per 5 minutes). */
final class SupportTicketRepliedMail extends SupportMail
{
    protected function headline(): string
    {
        return $this->count > 1 ? "Store Plix support sent {$this->count} new replies on {$this->reference}" : "Store Plix support replied on {$this->reference}";
    }

    protected function cta(): string
    {
        return 'Read and reply';
    }
}
