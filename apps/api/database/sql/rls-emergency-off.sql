-- Store Plix: EMERGENCY switch-off for Postgres row-level security (PHASE-5B-CONTRACT P5B-6, ADR 0012).
--
-- Drops every RLS policy and disables RLS on every table of App\Domain\Tenancy\Database\RlsTables::TENANT, as plain
-- SQL for an incident. Run as storeplix_owner (or a superuser):
--   psql -v ON_ERROR_STOP=1 -U storeplix_owner -d storeplix -f database/sql/rls-emergency-off.sql
-- The SECURITY DEFINER functions and the GUC helpers STAY (QA 5b-1 F-L6): a running app with TENANCY_RLS=true keeps
-- resolving storefront hosts through them, so there is no outage before the config change. Then set
-- TENANCY_RLS=false and restart web + workers at a calm moment. Re-enable later by re-running the policy migration
-- (`migrate:rollback --step=…` + `migrate`), which recreates the policies of every table in the list.
--
-- The table list must equal RlsTables::TENANT (RlsEmergencyScriptTest). Tables of later increments that do not exist
-- yet are skipped (to_regclass).

BEGIN;
-- table: tenant_users
DO $$
BEGIN
  IF to_regclass('public.tenant_users') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_users_membership ON "tenant_users";
    DROP POLICY IF EXISTS tenant_users_select ON "tenant_users";
    DROP POLICY IF EXISTS tenant_users_insert ON "tenant_users";
    DROP POLICY IF EXISTS tenant_users_update ON "tenant_users";
    DROP POLICY IF EXISTS tenant_users_delete ON "tenant_users";
    DROP POLICY IF EXISTS tenant_isolation ON "tenant_users";
    ALTER TABLE "tenant_users" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "tenant_users" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: audit_logs
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    DROP POLICY IF EXISTS audit_logs_select ON "audit_logs";
    DROP POLICY IF EXISTS audit_logs_insert ON "audit_logs";
    DROP POLICY IF EXISTS tenant_isolation ON "audit_logs";
    ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: stores
DO $$
BEGIN
  IF to_regclass('public.stores') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "stores";
    ALTER TABLE "stores" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "stores" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_domains
DO $$
BEGIN
  IF to_regclass('public.store_domains') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_domains";
    ALTER TABLE "store_domains" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_domains" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_settings
DO $$
BEGIN
  IF to_regclass('public.store_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_settings";
    ALTER TABLE "store_settings" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_settings" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: media
DO $$
BEGIN
  IF to_regclass('public.media') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "media";
    ALTER TABLE "media" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "media" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: staff_invitations
DO $$
BEGIN
  IF to_regclass('public.staff_invitations') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "staff_invitations";
    ALTER TABLE "staff_invitations" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "staff_invitations" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: subscriptions
DO $$
BEGIN
  IF to_regclass('public.subscriptions') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "subscriptions";
    ALTER TABLE "subscriptions" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "subscriptions" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: sms_messages
DO $$
BEGIN
  IF to_regclass('public.sms_messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS sms_messages_select ON "sms_messages";
    DROP POLICY IF EXISTS sms_messages_insert ON "sms_messages";
    DROP POLICY IF EXISTS sms_messages_update ON "sms_messages";
    DROP POLICY IF EXISTS tenant_isolation ON "sms_messages";
    ALTER TABLE "sms_messages" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "sms_messages" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_themes
DO $$
BEGIN
  IF to_regclass('public.store_themes') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_themes";
    ALTER TABLE "store_themes" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_themes" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_pages
DO $$
BEGIN
  IF to_regclass('public.store_pages') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_pages";
    ALTER TABLE "store_pages" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_pages" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_navigation
DO $$
BEGIN
  IF to_regclass('public.store_navigation') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_navigation";
    ALTER TABLE "store_navigation" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_navigation" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: categories
DO $$
BEGIN
  IF to_regclass('public.categories') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "categories";
    ALTER TABLE "categories" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: products
DO $$
BEGIN
  IF to_regclass('public.products') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "products";
    ALTER TABLE "products" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "products" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: product_variants
DO $$
BEGIN
  IF to_regclass('public.product_variants') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "product_variants";
    ALTER TABLE "product_variants" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "product_variants" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: product_images
DO $$
BEGIN
  IF to_regclass('public.product_images') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "product_images";
    ALTER TABLE "product_images" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "product_images" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: product_categories
DO $$
BEGIN
  IF to_regclass('public.product_categories') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "product_categories";
    ALTER TABLE "product_categories" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "product_categories" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: inventories
DO $$
BEGIN
  IF to_regclass('public.inventories') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "inventories";
    ALTER TABLE "inventories" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "inventories" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: inventory_movements
DO $$
BEGIN
  IF to_regclass('public.inventory_movements') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "inventory_movements";
    ALTER TABLE "inventory_movements" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "inventory_movements" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: customers
DO $$
BEGIN
  IF to_regclass('public.customers') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "customers";
    ALTER TABLE "customers" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "customers" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: customer_notes
DO $$
BEGIN
  IF to_regclass('public.customer_notes') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "customer_notes";
    ALTER TABLE "customer_notes" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "customer_notes" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: data_imports
DO $$
BEGIN
  IF to_regclass('public.data_imports') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "data_imports";
    ALTER TABLE "data_imports" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "data_imports" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: data_import_rows
DO $$
BEGIN
  IF to_regclass('public.data_import_rows') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "data_import_rows";
    ALTER TABLE "data_import_rows" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "data_import_rows" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: data_exports
DO $$
BEGIN
  IF to_regclass('public.data_exports') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "data_exports";
    ALTER TABLE "data_exports" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "data_exports" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: store_counters
DO $$
BEGIN
  IF to_regclass('public.store_counters') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "store_counters";
    ALTER TABLE "store_counters" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "store_counters" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: pickup_locations
DO $$
BEGIN
  IF to_regclass('public.pickup_locations') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "pickup_locations";
    ALTER TABLE "pickup_locations" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "pickup_locations" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: shipping_zones
DO $$
BEGIN
  IF to_regclass('public.shipping_zones') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "shipping_zones";
    ALTER TABLE "shipping_zones" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "shipping_zones" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: shipping_zone_areas
DO $$
BEGIN
  IF to_regclass('public.shipping_zone_areas') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "shipping_zone_areas";
    ALTER TABLE "shipping_zone_areas" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "shipping_zone_areas" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: coupons
DO $$
BEGIN
  IF to_regclass('public.coupons') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "coupons";
    ALTER TABLE "coupons" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "coupons" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: coupon_categories
DO $$
BEGIN
  IF to_regclass('public.coupon_categories') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "coupon_categories";
    ALTER TABLE "coupon_categories" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "coupon_categories" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: coupon_products
DO $$
BEGIN
  IF to_regclass('public.coupon_products') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "coupon_products";
    ALTER TABLE "coupon_products" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "coupon_products" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: carts
DO $$
BEGIN
  IF to_regclass('public.carts') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "carts";
    ALTER TABLE "carts" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "carts" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: cart_items
DO $$
BEGIN
  IF to_regclass('public.cart_items') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "cart_items";
    ALTER TABLE "cart_items" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "cart_items" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: orders
DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "orders";
    ALTER TABLE "orders" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "orders" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: order_items
DO $$
BEGIN
  IF to_regclass('public.order_items') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "order_items";
    ALTER TABLE "order_items" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "order_items" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: order_events
DO $$
BEGIN
  IF to_regclass('public.order_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "order_events";
    ALTER TABLE "order_events" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "order_events" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: shipments
DO $$
BEGIN
  IF to_regclass('public.shipments') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "shipments";
    ALTER TABLE "shipments" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "shipments" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: payments
DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "payments";
    ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "payments" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: coupon_redemptions
DO $$
BEGIN
  IF to_regclass('public.coupon_redemptions') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "coupon_redemptions";
    ALTER TABLE "coupon_redemptions" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "coupon_redemptions" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: idempotency_keys
DO $$
BEGIN
  IF to_regclass('public.idempotency_keys') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "idempotency_keys";
    ALTER TABLE "idempotency_keys" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "idempotency_keys" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: return_requests
DO $$
BEGIN
  IF to_regclass('public.return_requests') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "return_requests";
    ALTER TABLE "return_requests" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "return_requests" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: return_items
DO $$
BEGIN
  IF to_regclass('public.return_items') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "return_items";
    ALTER TABLE "return_items" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "return_items" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: return_events
DO $$
BEGIN
  IF to_regclass('public.return_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "return_events";
    ALTER TABLE "return_events" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "return_events" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: document_templates
DO $$
BEGIN
  IF to_regclass('public.document_templates') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "document_templates";
    ALTER TABLE "document_templates" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "document_templates" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- table: documents
DO $$
BEGIN
  IF to_regclass('public.documents') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON "documents";
    ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_app') THEN
    GRANT UPDATE, DELETE ON audit_logs TO storeplix_app;
  END IF;
END
$$;

COMMIT;
