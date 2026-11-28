<?php

declare(strict_types=1);

/*
 * PHASE-8-9D §5 / §12: tracking pixels and server-side events (Meta CAPI, GA4 Measurement Protocol, TikTok Events API,
 * GTM server container). Provider hosts are fixed here (P89D-17); the only merchant URL is the GTM tagging server.
 * API versions are VERIFY items (§5.2): check each provider's current docs before release.
 * TRACKING_FAKE=true: no provider calls, deliveries succeed (local / QA). Refused in production (boot check).
 */
return [
    'fake' => (bool) env('TRACKING_FAKE', false),
    'queue' => env('TRACKING_QUEUE', 'tracking'),

    'meta' => ['base_url' => 'https://graph.facebook.com', 'version' => env('META_GRAPH_VERSION', 'v21.0')],
    'ga4' => ['base_url' => 'https://www.google-analytics.com'],
    'tiktok' => ['base_url' => 'https://business-api.tiktok.com', 'version' => env('TIKTOK_EVENTS_VERSION', 'v1.3')],

    // P89D-15: 5 attempts — immediately, +1 min, +10 min, +1 h, +6 h — then a final check 16 h later (inside 24 h).
    'retry_delays' => [60, 600, 3600, 21600, 57600],
    'max_attempts' => 5,
    'lease_seconds' => 120,
    'max_retry_after' => 3600,
    'dispatch_batch' => 500,

    // P89D-16: ≥ 20 failed of the last 50 server events → attention `delivery_failing`.
    'failing_window' => 50,
    'failing_threshold' => 20,

    // P89D-18 retention (days).
    'retention' => ['delivered' => 7, 'failed' => 30, 'stats' => 90, 'context_ip' => 90, 'context' => 180],

    // P89D-59 abuse limits.
    'beacon_per_ip_per_minute' => 120,
    'beacon_per_host_per_minute' => 6000,
    'beacon_max_events' => 20,

    // P89D-19: test-mode link lifetime (minutes).
    'test_mode_minutes' => 30,

    // HTTP timeouts for provider calls (seconds).
    'http' => ['connect_timeout' => 5, 'timeout' => 10],
];
