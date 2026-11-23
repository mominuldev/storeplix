<?php

declare(strict_types=1);

/*
 * Platform billing (PHASE-7-CONTRACT §12, ADR 0008 as amended). Storeplix's OWN gateway accounts: never a merchant's
 * payment_gateway_accounts (S58). Empty credentials = that provider is not offered (`meta.providers`, P7-20).
 */
return [
    // P7-20: FakeBillingGateway for both providers + /dev/billing/* + /dev/fake-billing-gateway. Refused in production.
    'fake' => (bool) env('BILLING_FAKE', false),

    'gateway_mode' => env('BILLING_GATEWAY_MODE', 'sandbox') === 'live' ? 'live' : 'sandbox',

    'bkash' => [
        'app_key' => (string) env('BILLING_BKASH_APP_KEY', ''),
        'app_secret' => (string) env('BILLING_BKASH_APP_SECRET', ''),
        'username' => (string) env('BILLING_BKASH_USERNAME', ''),
        'password' => (string) env('BILLING_BKASH_PASSWORD', ''),
    ],
    'sslcommerz' => [
        'store_id' => (string) env('BILLING_SSLCOMMERZ_STORE_ID', ''),
        'store_passwd' => (string) env('BILLING_SSLCOMMERZ_STORE_PASSWD', ''),
    ],

    // Provider page hosts a `redirect_url` may point to (S59); the fake page is the API's own host.
    'redirect_hosts' => [
        'bkash' => ['sandbox.payment.bkash.com', 'payment.bkash.com', 'tokenized.sandbox.bka.sh', 'tokenized.pay.bka.sh'],
        'sslcommerz' => ['sandbox.sslcommerz.com', 'securepay.sslcommerz.com', 'epay.sslcommerz.com'],
    ],

    'grace_days' => (int) env('BILLING_GRACE_DAYS', 7),
    'renewal_lead_days' => (int) env('BILLING_RENEWAL_LEAD_DAYS', 7),
    'domain_grace_days' => (int) env('BILLING_DOMAIN_GRACE_DAYS', 7),
    'payment_hold_minutes' => (int) env('BILLING_PAYMENT_HOLD_MINUTES', 30),
    'change_invoice_ttl_hours' => (int) env('BILLING_CHANGE_INVOICE_TTL_HOURS', 24),
    'trial_reminder_days' => 3,
    'reminder_days' => [3, 1],
    'grace_reminder_days' => 2,

    // Q82: prices are VAT-inclusive.
    'vat_rate_bps' => (int) env('BILLING_VAT_RATE_BPS', 1500),
    'vat_bin' => env('BILLING_VAT_BIN'),
    'seller' => env('BILLING_SELLER', 'Storeplix, Dhaka, Bangladesh'),

    'ops_email' => env('BILLING_OPS_EMAIL'),

    // billing:run discovery batch (§4.1).
    'run_batch' => 1000,
];
