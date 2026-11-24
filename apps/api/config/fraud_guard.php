<?php

declare(strict_types=1);

// PHASE-8-8-CONTRACT (Phase 8.8a fake-order guard). Own-shop data only: no courier or cross-shop lookups (P88-1).
return [
    // §4: `fraud_guard_settings.enabled` default for a store that has no settings row yet. The test suite sets it to
    // false (phpunit.xml) so earlier phases' checkout tests keep their 8.7 flow; guard tests turn it on per store.
    'default_enabled' => (bool) env('FRAUD_GUARD_DEFAULT_ENABLED', true),

    // §5.1: a `checking` hold older than this is re-checked by `fraud:resolve-stale` (every 5 minutes).
    'stale_minutes' => 10,

    // §9: retention.
    'otp_retention_hours' => 24,
    'event_retention_months' => 13,

    // P88-13 checkout OTP.
    'otp' => [
        'ttl_seconds' => 300,
        'resend_seconds' => 60,
        'max_attempts' => 5,
        'per_phone_per_hour' => 5,
        'per_ip_per_hour' => 20,
        // a verified code keeps working for a re-submitted checkout (e.g. after "the total changed") this long
        'verified_grace_minutes' => 30,
        // an SMS failure for a number opens the fail-open path for this long
        'failure_minutes' => 30,
    ],

    // §6.3 `fraud-check` limiter.
    'check_per_minute' => 30,
];
