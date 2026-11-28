<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

/** To the new assignee (never on self-assign). `actor` = who assigned it. */
final class SupportTicketAssignedMail extends SupportMail
{
    protected function headline(): string
    {
        return "{$this->actor} assigned you {$this->reference}";
    }

    protected function cta(): string
    {
        return 'Open the ticket';
    }
}
