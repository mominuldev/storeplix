<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

/** To the requester (owner fallback): staff marked the ticket solved; the link leads to the rating card. */
final class SupportTicketResolvedMail extends SupportMail
{
    protected function headline(): string
    {
        return "Your ticket {$this->reference} was marked solved";
    }

    protected function cta(): string
    {
        return 'Rate our support';
    }
}
