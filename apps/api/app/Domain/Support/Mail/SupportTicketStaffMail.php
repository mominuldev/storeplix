<?php

declare(strict_types=1);

namespace App\Domain\Support\Mail;

/** To the assignee, else SUPPORT_TEAM_EMAIL: a new ticket, a merchant reply or a reopened ticket. */
final class SupportTicketStaffMail extends SupportMail
{
    public const CREATED = 'created';

    public const REPLIED = 'replied';

    public const REOPENED = 'reopened';

    protected function headline(): string
    {
        return match ($this->actor) {
            self::CREATED => "New ticket {$this->reference} from {$this->shop}",
            self::REOPENED => "{$this->shop} reopened {$this->reference}",
            default => "{$this->shop} replied on {$this->reference}",
        };
    }

    protected function cta(): string
    {
        return 'Open in the support queue';
    }
}
