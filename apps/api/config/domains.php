<?php

/*
| Phase 6 custom domains (PHASE-6-CONTRACT §11). Endpoints of external services come from here only, never from input.
*/

$platform = strtolower((string) env('PLATFORM_DOMAIN', 'storeplix.test'));

return [
    // true = FakeDnsResolver + FakeCustomHostnames + the /api/v1/dev/domains/* routes (local/testing/e2e).
    // The API refuses to boot with DOMAINS_FAKE=true in production (DomainsServiceProvider).
    'fake' => (bool) env('DOMAINS_FAKE', false),

    // Routing record every custom host must CNAME to (P6-1).
    'cname_target' => strtolower(rtrim((string) (env('DOMAINS_CNAME_TARGET') ?: 'customers.'.$platform), '.')),

    // Ownership record: TXT {txt_prefix}.{host} = "sp-verify={token}" (P6-1).
    'txt_prefix' => '_storeplix-verify',

    // GET /api/v1/internal/domains/allowed?key= (P6-17). Empty → the endpoint always answers 401.
    'ask_key' => (string) env('DOMAINS_ASK_KEY', ''),

    'verify_window_hours' => (int) env('DOMAINS_VERIFY_WINDOW_HOURS', 72),
    'ssl_window_hours' => (int) env('DOMAINS_SSL_WINDOW_HOURS', 24),
    'expire_after_days' => (int) env('DOMAINS_EXPIRE_AFTER_DAYS', 7),
    'reclaim_after_days' => (int) env('DOMAINS_RECLAIM_AFTER_DAYS', 7),
    // FakeCustomHostnames: number of `get` polls that still answer pending before the hostname turns active.
    'fake_ssl_polls' => (int) env('DOMAINS_FAKE_SSL_POLLS', 1),

    // domains:check discovery batch (rows with next_check_at <= now, oldest first).
    'check_batch' => 500,

    // P6-2: DNS over HTTPS (JSON API), two resolvers that must agree. Config only (no env), https only.
    'doh' => [
        'resolvers' => [
            'cloudflare' => 'https://cloudflare-dns.com/dns-query',
            'google' => 'https://dns.google/resolve',
        ],
        'timeout' => 3,
    ],

    // P6-11 / §5.2 Cloudflare for SaaS (custom hostnames API v4). Token + zone are secrets (env / secret manager).
    'cloudflare' => [
        'api_base' => (string) env('CLOUDFLARE_API_BASE', 'https://api.cloudflare.com/client/v4'),
        'api_token' => (string) env('CLOUDFLARE_API_TOKEN', ''),
        'zone_id' => (string) env('CLOUDFLARE_ZONE_ID', ''),
        'connect_timeout' => 10,
        'timeout' => 20,
    ],

    // P6-5: extra reserved suffixes. storeplix.com, PLATFORM_DOMAIN and the CNAME target are always added in code.
    'reserved_suffixes' => ['storeplix.com'],

    // P6-4: Public Suffix List snapshot (ICANN + private sections), refreshed by `php artisan domains:update-psl`.
    'psl_path' => resource_path('data/public_suffix_list.dat'),
    'psl_url' => 'https://publicsuffix.org/list/public_suffix_list.dat',
];
