<?php

declare(strict_types=1);

/*
 * Automations + checkout recovery (PHASE-8-6-CONTRACT; ADR 0020; SECURITY T36).
 *
 * Customer messages reuse the 8.5 send path (SmsGateway, the `campaigns` mailer, the dev sink, quiet hours from
 * config/campaigns.php). Jobs run on queue `automations` (worker: --tries=1 --timeout=250; every job $timeout ≤ 240 s
 * under REDIS_QUEUE_RETRY_AFTER 360).
 */
return [
    'queue' => 'automations',

    // Team notifications (P86-19) go through the transactional mail on the existing notifications queue.
    'notifications_queue' => 'notifications',

    // P86-7: ≤ 3 SMS parts incl. the shop prefix and the opt-out footer; email body ≤ 3,000 characters.
    'sms_max_parts' => 3,
    'email_body_max' => 3000,
    'sms_body_max' => 1000,

    // P86-10: automation marketing messages per (store, channel, address) per rolling 24 h.
    'frequency_cap' => 2,
    'frequency_window_hours' => 24,

    // P86-5: a step `sending` longer than this becomes `unknown` (never retried); a run `running` without progress for
    // this long is handed back to resume-due (executed steps are never repeated: UNIQUE(run_id, step_index)).
    'stuck_after_minutes' => 15,

    // P86-6 / Q162 retention.
    'run_retention_days' => 90,
    'conversion_retention_months' => 13,

    // P86-22 test messages per user per hour; §9.1 dry runs per user per minute.
    'test_sends_per_hour' => 5,
    'dry_runs_per_minute' => 30,

    // §7 storefront limiters (per shopper IP, per minute).
    'cart_contact_per_minute' => 10,
    'recover_per_minute' => 20,

    // §4.1 detect-abandoned: carts examined per store per sweep.
    'detect_batch' => 500,
];
