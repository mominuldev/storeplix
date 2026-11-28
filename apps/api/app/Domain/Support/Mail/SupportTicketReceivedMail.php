<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

/** To the requester: "We got your ticket T-n" (PHASE-8-9C §10). */
final class SupportTicketReceivedMail extends SupportMail
{
    protected function headline(): string
    {
        return "We got your ticket {$this->reference}";
    }

    protected function cta(): string
    {
        return 'View your ticket';
    }
}
