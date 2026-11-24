<?php

namespace App\Domain\Tenancy\Database;

/**
 * The single list of tenant tables under row-level security (PHASE-5B-CONTRACT §2.3). The policy migration, its
 * rollback, database/sql/rls-emergency-off.sql and RlsCoverageTest all use it; the coverage test fails when a
 * table with a tenant_id column is missing here or lacks a forced policy.
 *
 * Every later table with tenant_id (5b-2/5b-3: payment_gateway_accounts, payment_links, webhook_events,
 * courier_accounts, courier_area_mappings, shipment_events, shipment_batches) is created with RLS in its own
 * migration (`RlsPolicies::enable($db, $table)`) and added to TENANT in the same change. The 000100 policy migration
 * skips listed tables that don't exist yet, and database/sql/rls-emergency-off.sql must list exactly TENANT
 * (RlsEmergencyScriptTest).
 */
final class RlsTables
{
    /** Tables with a special policy instead of tenant_isolation (§2.3). */
    public const SPECIAL = ['tenant_users', 'audit_logs', 'sms_messages', 'roles', 'role_permissions'];

    /** @var list<string> every table with a tenant_id column (40 after Phase 5a, 45 after 5b-4/5b-5, 48 after 5b-2, 52 after 5b-3, 54 after Phase 7, 55 after Phase 8.2, 57 after Phase 8.3, 61 after Phase 8.4) */
    public const TENANT = [
        'tenant_users', 'audit_logs', 'stores', 'store_domains', 'store_settings', 'media', 'staff_invitations',
        'subscriptions', 'sms_messages', 'store_themes', 'store_pages', 'store_navigation', 'categories', 'products',
        'product_variants', 'product_images', 'product_categories', 'inventories', 'inventory_movements', 'customers',
        'customer_notes', 'data_imports', 'data_import_rows', 'data_exports', 'store_counters', 'pickup_locations',
        'shipping_zones', 'shipping_zone_areas', 'coupons', 'coupon_categories', 'coupon_products', 'carts',
        'cart_items', 'orders', 'order_items', 'order_events', 'shipments', 'payments', 'coupon_redemptions',
        'idempotency_keys',
        // 5b-5 order changes, 5b-4 documents (RLS enabled in their own migrations)
        'return_requests', 'return_items', 'return_events', 'document_templates', 'documents',
        // 5b-2 payments
        'payment_gateway_accounts', 'payment_links', 'webhook_events',
        // 5b-3 couriers
        'courier_accounts', 'shipment_events', 'courier_area_mappings', 'shipment_batches',
        // Phase 7 billing
        'billing_invoices', 'billing_payments',
        // Phase 8.2 analytics (PHASE-8-2 §5.1; app role also revoked, only pgsql_admin reads it)
        'tenant_daily_metrics',
        // Phase 8.3 roles (PHASE-8-3 §5.1; member-read special policy)
        'roles', 'role_permissions',
        // Phase 8.4 developer API (PHASE-8-4 §5.1; api_keys in 2026_12_01_000100, the webhook tables in 000200)
        'api_keys', 'webhook_endpoints', 'webhook_secrets', 'webhook_deliveries',
    ];

    /** PHASE-8-2 S84: tables the app role has no privilege on at all (only the admin connection reads/writes them). */
    public const APP_REVOKED = ['tenant_daily_metrics', 'platform_daily_metrics'];

    /** @var list<string> platform tables: no tenant_id, no RLS */
    public const PLATFORM = [
        'users', 'password_reset_tokens', 'sessions', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs',
        'personal_access_tokens', 'tenants', 'plans', 'otp_codes', 'migrations', 'platform_counters',
        // Phase 8.1 (PHASE-8-1 §5.1)
        'platform_recovery_codes', 'platform_invitations', 'platform_impersonations',
        // Phase 8.2 (PHASE-8-2 §5.1; app role revoked)
        'platform_daily_metrics',
    ];
}
