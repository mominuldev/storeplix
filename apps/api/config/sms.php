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
];
