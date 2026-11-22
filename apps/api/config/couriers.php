<?php

declare(strict_types=1);

/*
 * Couriers (PHASE-5B-CONTRACT §15, §6, ADR 0013). Base URLs are fixed per provider and mode: merchant input never
 * chooses a host (S27). Steadfast documents one base URL (no sandbox): both modes use it.
 */
return [
    // FakeCourier for every provider (+ couriers:fake-advance). Refused in production (boot check).
    'fake' => (bool) env('COURIERS_FAKE', false),

    // Outbound HTTP (§3): 10 s connect / 30 s total, no redirects.
    'http' => [
        'connect_timeout' => (int) env('COURIERS_HTTP_CONNECT_TIMEOUT', 10),
        'timeout' => (int) env('COURIERS_HTTP_TIMEOUT', 30),
    ],

    // P5B-38 polling.
    'sync_minutes' => (int) env('COURIER_SYNC_MINUTES', 15),
    'sync_batch' => (int) env('COURIER_SYNC_BATCH', 100),

    // P5B-39: courier area lists are cached per account.
    'areas_cache_seconds' => 86400,

    'providers' => [
        'steadfast' => [
            'base_urls' => [
                'sandbox' => env('STEADFAST_BASE_URL', 'https://portal.packzy.com/api/v1'),
                'live' => env('STEADFAST_BASE_URL', 'https://portal.packzy.com/api/v1'),
            ],
            'bulk_chunk' => 500,
            'tracking_url' => 'https://steadfast.com.bd/t/{tracking_code}', // VERIFY against sandbox
        ],
        'pathao' => [
            'base_urls' => [
                'sandbox' => env('PATHAO_SANDBOX_BASE_URL', 'https://courier-api-sandbox.pathao.com'),
                'live' => env('PATHAO_LIVE_BASE_URL', 'https://api-hermes.pathao.com'),
            ],
            // Access token cached for expires_in − margin; a rejected issue-token is cached as an error for 5 min.
            'token_margin_seconds' => 3600,
            'token_failure_seconds' => 300,
            'tracking_url' => 'https://merchant.pathao.com/tracking?consignment_id={consignment_id}', // VERIFY against sandbox
        ],
        'redx' => [
            'base_urls' => [
                'sandbox' => env('REDX_SANDBOX_BASE_URL', 'https://sandbox.redx.com.bd/v1.0.0-beta'),
                'live' => env('REDX_LIVE_BASE_URL', 'https://openapi.redx.com.bd/v1.0.0-beta'),
            ],
            'tracking_url' => 'https://redx.com.bd/track-global-parcel/?trackingId={tracking_code}', // VERIFY against sandbox
        ],
    ],
];
