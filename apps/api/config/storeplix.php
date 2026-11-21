<?php

return [

    /*
    | Application version reported by GET /api/v1/health.
    */
    'version' => env('APP_VERSION', '0.1.0'),

    /*
    | Base platform domain. Every store gets "{slug}.{platform_domain}".
    | Local: storeplix.test, production: storeplix.com.
    */
    'platform_domain' => strtolower((string) env('PLATFORM_DOMAIN', 'storeplix.test')),

    /*
    | Shared secret the storefront app must send as X-Storefront-Key.
    | An empty value means every storefront request is rejected (fail closed).
    */
    'storefront_api_key' => env('STOREFRONT_API_KEY'),

    /*
    | Hostname -> store resolution cache (tenant-neutral key "domain:{host}").
    */
    'domain_cache_ttl' => (int) env('DOMAIN_CACHE_TTL', 3600),
    'domain_negative_cache_ttl' => (int) env('DOMAIN_NEGATIVE_CACHE_TTL', 60),

    /*
    | Slugs that may never be claimed by a store (they collide with platform hosts).
    */
    'reserved_slugs' => [
        'www', 'api', 'app', 'admin', 'dashboard', 'merchant', 'merchants', 'store', 'stores',
        'mail', 'email', 'smtp', 'ftp', 'cdn', 'static', 'assets', 'status', 'help', 'support',
        'docs', 'blog', 'billing', 'account', 'accounts', 'auth', 'login', 'signup', 'register',
        'storeplix', 'super-admin', 'superadmin', 'staging', 'dev', 'test', 'demo-admin',
    ],

    /*
    | Default theme configuration applied to every new store (ThemeConfig in @storeplix/types).
    */
    'default_theme' => [
        'theme' => 'modern-commerce',
        'version' => '1.0.0',
        'settings' => [
            'primaryColor' => '#5b53ff',
            'secondaryColor' => '#0d0d18',
            'fontFamily' => 'Inter',
        ],
        'sections' => [
            ['type' => 'hero', 'enabled' => true],
            ['type' => 'featured-products', 'enabled' => true],
        ],
    ],

];
