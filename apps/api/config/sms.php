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
];
