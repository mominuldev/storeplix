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
    public const SPECIAL = ['tenant_users', 'audit_logs', 'sms_messages', 'roles', 'role_permissions', 'sms_credit_ledger', 'ai_credit_ledger'];

    /** @var list<string> every table with a tenant_id column (40 after Phase 5a, 45 after 5b-4/5b-5, 48 after 5b-2, 52 after 5b-3, 54 after Phase 7, 55 after Phase 8.2, 57 after Phase 8.3, 61 after Phase 8.4, 65 after Phase 8.5, 69 after Phase 8.6, 71 after Phase 8.7, 76 after Phase 8.8a, 82 after Phase 8.8b, 83 after Phase 8.8c-A, 87 after Phase 8.8c, 90 after Phase 8.8d-A, 91 after Phase 8.8d, 95 after Phase 8.9a, 103 after Phase 8.8e, 106 after Phase 8.9c, 112 after Phase 8.9d-A, 115 after Phase 8.9d-B) */
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
        // Phase 8.5 marketing campaigns (PHASE-8-5 §7.1; campaign tables in 2026_12_02_000100, suppressions in 000200)
        'campaigns', 'campaign_recipients', 'campaign_conversions', 'marketing_suppressions',
        // Phase 8.6 automations (PHASE-8-6 §4.4; all four in 2026_12_03_000100)
        'automations', 'automation_runs', 'automation_run_steps', 'automation_conversions',
        // Phase 8.7 expenses (PHASE-8-7 §4; both in 2026_12_04_000100)
        'expense_recurrences', 'expenses',
        // Phase 8.8a fake-order guard (PHASE-8-8 §4; all five in 2026_12_05_000100)
        'fraud_guard_settings', 'blocked_phones', 'order_risk_checks', 'fraud_guard_events', 'checkout_otps',
        // Phase 8.8b purchasing (PHASE-8-8B §3; all six in 2026_12_06_000100)
        'suppliers', 'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'purchase_receipt_items', 'supplier_payments',
        // Phase 8.8c-A locations (PHASE-8-8C §3.1; 2026_12_07_000100)
        'locations',
        // Phase 8.8c-B transfers + counts (PHASE-8-8C §3.2; 2026_12_08_000100 / 000200)
        'stock_transfers', 'stock_transfer_items', 'stock_counts', 'stock_count_items',
        // Phase 8.8d-A POS (PHASE-8-8D §3.1; registers + sessions in 2026_12_10_000100, sales in 000200)
        'pos_registers', 'pos_sessions', 'pos_sales',
        // Phase 8.8d-B held sales (PHASE-8-8D §3.1; 2026_12_10_000300)
        'pos_held_sales',
        // Phase 8.9a SMS (PHASE-8-9A §3.1; credits in 2026_12_11_000100, templates 000200, sender IDs 000300)
        'sms_credit_accounts', 'sms_credit_ledger', 'sms_templates', 'sms_sender_ids',
        // Phase 8.8e Inbox (PHASE-8-8E §3; settings 2026_12_13_000100, conversations 000200, messages + attachments 000300,
        // reads 000400, saved replies 000500, widget sessions + magic links 000600)
        'inbox_settings', 'inbox_conversations', 'inbox_messages', 'inbox_attachments', 'inbox_reads', 'inbox_saved_replies',
        'inbox_widget_sessions', 'inbox_magic_links',
        // Phase 8.9c support tickets (PHASE-8-9C §3.1; tickets 2026_12_14_000400, messages + attachments 000500)
        'support_tickets', 'support_ticket_messages', 'support_ticket_attachments',
        // Phase 8.9d-A integrations (PHASE-8-9D §3.1; 2026_12_15_000100 … 000600)
        'store_integrations', 'tracking_events', 'tracking_daily_stats', 'order_tracking_contexts', 'catalog_sync_runs', 'catalog_items',
        // Phase 8.9d-B AI (PHASE-8-9D §3.2; credits 2026_12_15_000700, generations 000800)
        'ai_credit_accounts', 'ai_credit_ledger', 'ai_generations',
    ];

    /** PHASE-8-2 S84: tables the app role has no privilege on at all (only the admin connection reads/writes them). */
    public const APP_REVOKED = ['tenant_daily_metrics', 'platform_daily_metrics', 'platform_sms_broadcasts', 'platform_sms_broadcast_recipients'];

    /**
     * PHASE-8-9B §3.1: platform tables whose `tenant_id` names the SUBJECT (the merchant a platform row is about), not an
     * RLS owner. No RLS, no grant to the app role (only `pgsql_admin` reads and writes them). Excluded from TENANT.
     * PHASE-8-9C §3.1: `help_article_feedback.tenant_id` is the voter's shop (context for staff stats); the app role
     * writes its own vote rows (user id checked in code).
     *
     * @var list<string>
     */
    public const PLATFORM_SUBJECT = ['platform_sms_broadcast_recipients', 'help_article_feedback'];

    /** @var list<string> platform tables: no tenant_id, no RLS */
    public const PLATFORM = [
        'users', 'password_reset_tokens', 'sessions', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs',
        'personal_access_tokens', 'tenants', 'plans', 'otp_codes', 'migrations', 'platform_counters',
        // Phase 8.1 (PHASE-8-1 §5.1)
        'platform_recovery_codes', 'platform_invitations', 'platform_impersonations',
        // Phase 8.2 (PHASE-8-2 §5.1; app role revoked)
        'platform_daily_metrics',
        // PHASE-8-1 amendment A1-2 (app role SELECT only; writes on the admin connection)
        'platform_settings',
        // Phase 8.9b (PHASE-8-9B §3.1; providers/types/templates: app role SELECT only; broadcasts: no grant)
        'sms_providers', 'platform_sms_message_types', 'platform_sms_templates', 'platform_sms_broadcasts',
        'platform_sms_broadcast_recipients',
        // Phase 8.9c help center (PHASE-8-9C §3.1; app role SELECT, feedback + daily views also written by the app role)
        'help_categories', 'help_media', 'help_articles', 'help_article_translations', 'help_article_redirects',
        'help_article_feedback', 'help_article_daily_views',
    ];
}
