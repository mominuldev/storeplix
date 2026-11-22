<?php

// Phase 5b-4 documents (PHASE-5B-CONTRACT §7, §15, ADR 0014).
return [
    // `gotenberg` (PDF, compose + production) or `html` (stores the rendered HTML; local dev and CI without the
    // container, P5B-57). Defaults to `html` so a missing env never points at an absent service.
    'driver' => env('DOCUMENTS_DRIVER', 'html'),

    'gotenberg' => [
        'url' => env('GOTENBERG_URL', 'http://gotenberg:3000'),
        'username' => env('GOTENBERG_USERNAME'),
        'password' => env('GOTENBERG_PASSWORD'),
        'timeout' => (int) env('GOTENBERG_TIMEOUT', 30),
        'connect_timeout' => 10,
    ],

    'ttl_hours' => 24,          // files deleted by documents:prune
    'max_orders' => 100,        // per document
    'max_queued' => 10,         // queued + rendering per store (409 conflict beyond)
    'download_minutes' => 5,    // signed download URL lifetime
    'logo_max_bytes' => 524288, // larger logos are left out
];
