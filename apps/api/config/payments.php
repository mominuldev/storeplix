<?php

declare(strict_types=1);

/*
 * Online payments (PHASE-5B-CONTRACT §15, §5). Base URLs are fixed per provider and mode: merchant input never
 * chooses a host (S27). bKash publishes no live base URL: live mode stays unavailable until BKASH_LIVE_BASE_URL is set.
 */
return [
    // P5B-29: FakeGateway for every provider + the /dev/fake-gateway page. Refused in production (boot check).
    'fake' => (bool) env('PAYMENTS_FAKE', false),

    'hold_minutes' => (int) env('PAYMENT_HOLD_MINUTES', 30),
    'link_default_minutes' => (int) env('PAYMENT_LINK_DEFAULT_MINUTES', 120),

    // Test payment amount (P5B-11): ৳ 10 sandbox / ৳ 1 live, in paisa.
    'test_amount' => ['sandbox' => 1000, 'live' => 100],

    // Outbound HTTP (§3): 10 s connect / 30 s total, no redirects.
    'http' => [
        'connect_timeout' => (int) env('PAYMENTS_HTTP_CONNECT_TIMEOUT', 10),
        'timeout' => (int) env('PAYMENTS_HTTP_TIMEOUT', 30),
    ],

    'providers' => [
        'bkash' => [
            'base_urls' => [
                'sandbox' => env('BKASH_SANDBOX_BASE_URL', 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout'),
                'live' => env('BKASH_LIVE_BASE_URL'),
            ],
            // Grant token cache: expires_in − 600 s; a failed grant is cached 5 min (2 calls/hour limit).
            'token_margin_seconds' => 600,
            'grant_failure_seconds' => 300,
            'grant_calls_per_hour' => 2,
        ],
        'sslcommerz' => [
            'base_urls' => [
                'sandbox' => env('SSLCOMMERZ_SANDBOX_BASE_URL', 'https://sandbox.sslcommerz.com'),
                'live' => env('SSLCOMMERZ_LIVE_BASE_URL', 'https://securepay.sslcommerz.com'),
            ],
        ],
    ],

    // Base for signed return URLs and webhook URLs shown to merchants (a tunnel URL in sandbox work).
    'public_api_url' => env('PUBLIC_API_URL', env('APP_URL', 'http://localhost:8010')),
];
