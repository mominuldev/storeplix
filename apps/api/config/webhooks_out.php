<?php

declare(strict_types=1);

/*
 * Outbound merchant webhooks (PHASE-8-4-CONTRACT §4, P84-8 … P84-14; SECURITY T34 / T14).
 *
 * WEBHOOKS_OUT_FAKE=true: no HTTP at all; the fake records each request in the dev sink
 * (GET /api/v1/dev/webhook-sink) and answers per URL path suffix (`/fail-503` → 503, `/timeout` → timeout, else 200).
 * WEBHOOKS_OUT_ALLOW_HTTP=true: plain http:// endpoints (local receivers). Both refuse to boot in production (S112).
 */
return [
    'fake' => (bool) env('WEBHOOKS_OUT_FAKE', false),
    'allow_http' => (bool) env('WEBHOOKS_OUT_ALLOW_HTTP', false),

    'queue' => 'webhooks-out',

    // P84-10: success = any 2xx within 10 s (connect 5 s); no redirects.
    'connect_timeout' => 5,
    'timeout' => 10,

    // P84-9: attempt 1 at once, then these delays after each failed attempt (7 attempts, ≈ 20.6 h); then `failed`.
    'retry_delays_seconds' => [60, 300, 1800, 7200, 21600, 43200],

    // P84-11: an endpoint failing for this long (no 2xx since its first failure) is auto-disabled.
    'auto_disable_hours' => 72,

    // Q135: delivery log retention.
    'retention_days' => 30,

    // P84-14.
    'max_endpoints_per_store' => 5,

    // §4.2: larger bodies carry the subject ids only (`truncated: true`).
    'max_body_bytes' => 262144,
    'response_excerpt_bytes' => 1024,

    // §4.4 "Resend failed (n)": failed deliveries of the last 24 h, at most this many per call.
    'resend_failed_hours' => 24,
    'resend_failed_max' => 100,

    // webhooks:dispatch-due picks at most this many due deliveries per run.
    'dispatch_batch' => 500,

    // A claimed attempt holds the row this long, so the minute sweep never sends the same delivery twice.
    'attempt_lease_seconds' => 120,

    // §4.3: port 443 or 1024–65535, except these well-known internal service ports.
    'blocked_ports' => [
        1080, 2375, 2376, 2379, 2380, 3306, 4369, 5432, 5672, 5984, 6379, 6443, 7001, 8200, 8500, 8983, 9000, 9042,
        9092, 9200, 9300, 10250, 10255, 11211, 15672, 27017, 50070,
    ],

    // Dev sink (fake driver only): newest N requests per tenant.
    'sink_size' => 50,
];
