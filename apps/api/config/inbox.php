<?php

declare(strict_types=1);

// Phase 8.8e Inbox (PHASE-8-8E-CONTRACT §11.1, P88E-11/12/15). Secrets fall back to values derived from APP_KEY so a
// fresh environment works; production sets its own. Never logged.
return [
    // Per-store inbound address `shop-{key}@{mail_domain}`; per-conversation / per-order signed reply addresses.
    'mail_domain' => strtolower((string) env('INBOX_MAIL_DOMAIN', '')),

    // fake | mailgun (Q299: the provider choice is open). Unset = the email channel is unavailable.
    'inbound_driver' => env('INBOUND_MAIL_DRIVER'),

    'mailgun' => [
        'signing_key' => env('MAILGUN_WEBHOOK_SIGNING_KEY'),
    ],

    // The `fake` driver (never in production) signs like Mailgun with this key.
    'fake' => [
        'signing_key' => env('INBOUND_MAIL_FAKE_KEY', 'fake-inbound-signing-key'),
    ],

    'reply_secret' => env('INBOX_REPLY_SECRET'),
    'code_secret' => env('INBOX_CODE_SECRET'),
    'order_secret' => env('INBOX_ORDER_SECRET'),

    // P88E-12: reply SMS delay and throttle.
    'reply_sms_delay_seconds' => 120,
    'reply_sms_throttle_minutes' => 30,

    // P88E-11: chat verification code.
    'code_ttl_minutes' => 10,
    'code_attempts' => 5,
    'code_resend_seconds' => 60,
    'code_sends_per_phone_per_hour' => 5,
    'code_sends_per_ip_per_hour' => 20,

    // P88E-18: retention.
    'retention_months' => 24,
];
