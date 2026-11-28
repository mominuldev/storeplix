<?php

declare(strict_types=1);

/*
 * PHASE-8-9D §7: product feeds — Meta catalog (Catalog Batch API, OAuth "Facebook Login for Business") and Google
 * Merchant Center (Merchant API, Q346 — the Content API for Shopping is being shut down). Hosts are fixed here
 * (P89D-17). FEEDS_FAKE=true: OAuth returns a canned token, items are accepted (local / QA). Refused in production.
 * Versions are VERIFY items (§7.3).
 */
return [
    'fake' => (bool) env('FEEDS_FAKE', false),
    'queue' => env('FEEDS_QUEUE', 'feeds'),
    // Queue connection for SyncCatalog (null = the default). Compose sets `redis-feeds` (retry_after > the 900 s job).
    'connection' => env('FEEDS_QUEUE_CONNECTION'),

    // The public OAuth callback base (this API): {api_url}/api/v1/integrations/oauth/{provider}/callback.
    'api_url' => env('FEEDS_API_URL', env('APP_URL', 'http://localhost:8010')),

    'meta' => [
        'app_id' => env('META_APP_ID'),
        'app_secret' => env('META_APP_SECRET'),
        'config_id' => env('META_LOGIN_CONFIG_ID'),
        'graph_url' => 'https://graph.facebook.com',
        'dialog_url' => 'https://www.facebook.com',
        'version' => env('META_GRAPH_VERSION', 'v21.0'),
        'scopes' => ['catalog_management', 'business_management'],
        'batch_size' => 5000,
        'renew_when_days_left' => 10,
    ],
    'google' => [
        'client_id' => env('GOOGLE_OAUTH_CLIENT_ID'),
        'client_secret' => env('GOOGLE_OAUTH_CLIENT_SECRET'),
        'auth_url' => 'https://accounts.google.com',
        'token_url' => 'https://oauth2.googleapis.com',
        'merchant_url' => 'https://merchantapi.googleapis.com',
        'site_verification_url' => 'https://www.googleapis.com',
        'merchant_version' => env('GOOGLE_MERCHANT_API_VERSION', 'v1'),
        'scopes' => ['https://www.googleapis.com/auth/content', 'https://www.googleapis.com/auth/siteverification'],
        'batch_size' => 250,
    ],

    'state_ttl_minutes' => 10,
    'delta_window_minutes' => 15,
    'description_max' => 5000,
    'issue_message_max' => 300,
    'runs_retention_days' => 90,
];
