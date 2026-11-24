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
    | Merchant dashboard base URL (links in reset-password / invitation emails).
    */
    'merchant_app_url' => env('MERCHANT_APP_URL', 'http://localhost:5183'),

    /*
    | Media storage (Phase 2 §1.5). MEDIA_URL overrides the disk's public base URL (e.g. CDN).
    */
    'media_disk' => env('MEDIA_DISK', 'public'),
    'media_url' => env('MEDIA_URL'),

    /*
    | Storefront on-demand revalidation (QA M-1). Empty values make the job a no-op.
    */
    'revalidate_url' => env('STOREFRONT_REVALIDATE_URL'),
    'revalidate_secret' => env('REVALIDATE_SECRET'),

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
    | Business category codes (BUSINESS_CATEGORIES in @storeplix/types).
    */
    'business_categories' => ['fashion', 'beauty', 'kids', 'food_grocery', 'electronics', 'home'],

    'bd_divisions' => ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet'],

    /*
    | Phase 4: bulk data (CSV imports/exports). Private disk for import uploads and export files
    | (tenant-prefixed via TenantStorage); merchant-bulk throttle per tenant per hour (SECURITY T24).
    */
    'private_disk' => env('PRIVATE_DISK', 'local'),
    'bulk_per_hour' => (int) env('THROTTLE_MERCHANT_BULK_PER_HOUR', 10),

    /*
    | Phase 5b (P5B-9, PHASE-5B-CONTRACT §2.10): `storefront` limiter = per store host + trusted shopper IP
    | (X-Storefront-Client-Ip with a valid key; IPv6 by /64) AND per store host. e2e raises both.
    */
    'storefront_per_ip_per_minute' => (int) env('THROTTLE_STOREFRONT_PER_IP', 300),
    'storefront_per_host_per_minute' => (int) env('THROTTLE_STOREFRONT_PER_HOST', 3000),

    // Phase 3: theme defaults come from resources/themes/{code}/defaults.json (ThemeRegistry).

];
