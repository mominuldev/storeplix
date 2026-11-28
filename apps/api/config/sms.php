<?php

return [
    // revesms (production) | log (local dev: writes to the log, sends nothing) | fake (tests)
    'driver' => env('SMS_DRIVER', 'log'),

    'revesms' => [
        'base_url' => env('REVESMS_BASE_URL', 'https://smpp.revesms.com:7790'),
        // Credentials only ever travel in the POST body — never in URLs or logs.
        'api_key' => env('REVESMS_API_KEY'),
        'secret_key' => env('REVESMS_SECRET_KEY'),
        'caller_id' => env('REVESMS_CALLER_ID'),
        'timeout' => 10,
        'retries' => 2, // connection errors only
    ],

    // PHASE-8-9A P89A-9 (Q259): SMS credit packs (1 credit = 1 SMS part), price in BDT paisa, VAT included. Order = display order.
    'packs' => [
        'credits_1000' => ['credits' => 1000, 'price_amount' => 35000],
        'credits_5000' => ['credits' => 5000, 'price_amount' => 160000],
        'credits_10000' => ['credits' => 10000, 'price_amount' => 300000],
    ],

    // P89A-9: an open SMS-credit invoice lives this long, then billing:run voids it (`expired`).
    'invoice_hours' => 24,

    // P89A-12 (Q269): default low-credit threshold set on the first grant; allowed values.
    'low_credit_default' => 200,
    'low_credit_thresholds' => [100, 200, 500],

    // P89A-13 / P89A-15 (Q263): masked sender IDs. The platform caller ID is always reserved too.
    'sender_id_pattern' => '/^(?=.*[A-Za-z])[A-Za-z0-9]{3,11}$/',
    'reserved_sender_ids' => ['storeplix', 'store', 'plix', 'bkash', 'nagad', 'rocket', 'upay', 'sslcommerz', 'gp', 'grameenphone',
        'robi', 'airtel', 'banglalink', 'teletalk', 'btrc', 'police', 'rab', 'govt', 'bangladesh', 'bank', 'otp', 'info', 'alert',
        'verify', 'admin', 'support', 'daraz', 'pathao', 'steadfast', 'redx', 'reve', 'revesms'],
    'sender_id_requests_per_day' => 5,
    // §8.2: trade licences of finished requests are pruned this many days after the request ended.
    'sender_document_retention_days' => 180,

    // P89A-2: test SMS (fixed text, `{shop}: ` prefix rule applies), 5 per hour per member and store.
    'test_texts' => [
        'bn' => '{shop}: এটি Store Plix থেকে একটি পরীক্ষামূলক SMS। আপনার দোকানের SMS চালু আছে।',
        'en' => "{shop}: This is a test SMS from Store Plix. Your shop's SMS is working.",
    ],
    'test_per_hour' => 5,

    // P89A-8: a template's sample render must fit this many parts. P89A-19 / P89A-21: log window and preview retention.
    'template_max_parts' => 3,
    'log_days' => 90,
    'preview_days' => 90,

    // ---------- PHASE-8-9B: platform SMS providers, failover, platform messages, broadcasts ----------
    // §4.2 (S231): every provider driver call answers a canned success (no network). Dev / e2e only; refused at boot in production.
    'providers_http_fake' => (bool) env('SMS_PROVIDERS_HTTP_FAKE', false),

    // §4.2 driver catalogue (`GET /admin/sms/drivers`). Prices: list price per SMS part in paisa, VAT included.
    'drivers' => [
        'revesms' => [
            'name' => 'REVE SMS', 'status' => 'available', 'recommended' => true, 'btrc_approved' => true,
            'price_masking_paisa' => 45, 'price_non_masking_paisa' => 25,
            'features' => ['masking' => true, 'dlr' => false, 'unicode' => true, 'balance' => true],
            'credential_fields' => [
                ['key' => 'api_key', 'label' => 'API key', 'secret' => true, 'required' => true, 'hint' => 'From the REVE SMS portal: Settings → API.'],
                ['key' => 'secret_key', 'label' => 'Secret key', 'secret' => true, 'required' => true, 'hint' => 'From the REVE SMS portal: Settings → API.'],
            ],
            'settings_fields' => [
                ['key' => 'account_id', 'label' => 'Account ID', 'secret' => false, 'required' => false, 'hint' => null],
                ['key' => 'base_url', 'label' => 'API endpoint', 'secret' => false, 'required' => true, 'hint' => 'Use an https:// address.'],
            ],
            'default_base_url' => 'https://smpp.revesms.com:7790',
            'portal_url' => 'https://smpp.revesms.com',
        ],
        'ssl_wireless' => [
            'name' => 'SSL Wireless', 'status' => 'coming_soon', 'recommended' => false, 'btrc_approved' => true,
            'price_masking_paisa' => 50, 'price_non_masking_paisa' => 30,
            'features' => ['masking' => true, 'dlr' => false, 'unicode' => true, 'balance' => false],
            'credential_fields' => [], 'settings_fields' => [], 'default_base_url' => null,
        ],
        'alpha_sms' => [
            'name' => 'Alpha SMS', 'status' => 'coming_soon', 'recommended' => false, 'btrc_approved' => true,
            'price_masking_paisa' => 45, 'price_non_masking_paisa' => 25,
            'features' => ['masking' => true, 'dlr' => false, 'unicode' => true, 'balance' => false],
            'credential_fields' => [], 'settings_fields' => [], 'default_base_url' => null,
        ],
        'bulksmsbd' => [
            'name' => 'BulkSMSBD', 'status' => 'coming_soon', 'recommended' => false, 'btrc_approved' => true,
            'price_masking_paisa' => 40, 'price_non_masking_paisa' => 25,
            'features' => ['masking' => true, 'dlr' => false, 'unicode' => true, 'balance' => false],
            'credential_fields' => [], 'settings_fields' => [], 'default_base_url' => null,
        ],
        'http' => [
            'name' => 'Other (HTTP API)', 'status' => 'available', 'recommended' => false, 'btrc_approved' => false,
            'price_masking_paisa' => null, 'price_non_masking_paisa' => null,
            'features' => ['masking' => true, 'dlr' => false, 'unicode' => true, 'balance' => false],
            // free keys (1–5, `[a-z_]{2,32}`, all secret) — the configure drawer composes them.
            'credential_fields' => [],
            'settings_fields' => [
                ['key' => 'base_url', 'label' => 'API endpoint', 'secret' => false, 'required' => true, 'hint' => 'Use an https:// address.'],
            ],
            'default_base_url' => null,
        ],
    ],

    'platform' => [
        // P89B-8: breaker half-opens after this many seconds without a new failure.
        'breaker_cooldown_seconds' => 300,
        // §4.3: provider rows are read through this cache (flushed on every provider write).
        'routing_cache_seconds' => 60,
        // P89B-10: retry window of platform SMS (codes: 5 min) and the job backoff.
        'retry_window_minutes' => 30,
        'code_retry_window_minutes' => 5,
        'retry_backoff_seconds' => [30, 60, 120, 240, 480, 900],
        // P89B-26 / S232 limiters.
        'test_per_hour' => 10,
        'export_per_hour' => 5,
        'refresh_balance_per_hour' => 6,
        'opt_out_per_minute' => 30,
        'export_max_rows' => 50000,
        // P89B-18 / P89B-20: promotional sending hours (Asia/Dhaka) and the weekly cap per tenant.
        'timezone' => 'Asia/Dhaka',
        'sending_hours' => ['from' => 9, 'to' => 21],
        'weekly_cap' => 2,
        'broadcast_batch' => 100,
        // P89B-21: opt-out link base (default `{MERCHANT_APP_URL}/s`).
        'opt_out_base' => env('PLATFORM_SMS_OPT_OUT_BASE'),
        // P89B-24: recipients rows are pruned after this many months.
        'recipient_retention_months' => 13,
        // P89B-23: default low-balance threshold (৳1,000).
        'low_threshold_paisa' => 100000,
    ],
];
