<?php

declare(strict_types=1);

/*
 * PHASE-8-9C P89C-21 (Q320): support ticket notifications. Staff-side mail (new ticket, merchant reply, reopened) goes to
 * the assignee, else to this team address; unset = no staff mail for unassigned tickets.
 */
return [
    'team_email' => env('SUPPORT_TEAM_EMAIL'),
    // at most one "staff replied" mail per ticket per this many seconds; later replies are summed into one mail
    'reply_mail_window_seconds' => (int) env('SUPPORT_REPLY_MAIL_WINDOW', 300),
];
