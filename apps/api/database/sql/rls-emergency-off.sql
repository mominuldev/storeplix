-- Store Plix: EMERGENCY switch-off for Postgres row-level security (PHASE-5B-CONTRACT P5B-6, ADR 0012).
--
-- Same effect as `php artisan migrate:rollback --step=1 --database=pgsql_owner` on
-- 2026_06_01_000100_enable_row_level_security, as plain SQL for an incident. Run as storeplix_owner (or a superuser):
--   psql -v ON_ERROR_STOP=1 -U storeplix_owner -d storeplix -f database/sql/rls-emergency-off.sql
-- Then set TENANCY_RLS=false and restart web + workers (the definer functions are gone, so the app must stop
-- calling them). The migrations row stays: re-enable with `migrate:rollback --step=1` + `migrate` later, or
-- re-run the migration after deleting its row from `migrations`.
--
-- Keep the table list in sync with App\Domain\Tenancy\Database\RlsTables::TENANT.

BEGIN;

DROP POLICY IF EXISTS tenant_users_membership ON "tenant_users";
DROP POLICY IF EXISTS tenant_isolation ON "tenant_users";
ALTER TABLE "tenant_users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_users" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select ON "audit_logs";
DROP POLICY IF EXISTS audit_logs_insert ON "audit_logs";
DROP POLICY IF EXISTS tenant_isolation ON "audit_logs";
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "stores";
ALTER TABLE "stores" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "stores" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_domains";
ALTER TABLE "store_domains" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_domains" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_settings";
ALTER TABLE "store_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_settings" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "media";
ALTER TABLE "media" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "media" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "staff_invitations";
ALTER TABLE "staff_invitations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_invitations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "subscriptions";
ALTER TABLE "subscriptions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_messages_select ON "sms_messages";
DROP POLICY IF EXISTS sms_messages_insert ON "sms_messages";
DROP POLICY IF EXISTS sms_messages_update ON "sms_messages";
DROP POLICY IF EXISTS tenant_isolation ON "sms_messages";
ALTER TABLE "sms_messages" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sms_messages" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_themes";
ALTER TABLE "store_themes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_themes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_pages";
ALTER TABLE "store_pages" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_pages" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_navigation";
ALTER TABLE "store_navigation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_navigation" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "categories";
ALTER TABLE "categories" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "products";
ALTER TABLE "products" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "product_variants";
ALTER TABLE "product_variants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "product_variants" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "product_images";
ALTER TABLE "product_images" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "product_images" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "product_categories";
ALTER TABLE "product_categories" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "product_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "inventories";
ALTER TABLE "inventories" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "inventory_movements";
ALTER TABLE "inventory_movements" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "customers";
ALTER TABLE "customers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "customers" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "customer_notes";
ALTER TABLE "customer_notes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "customer_notes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "data_imports";
ALTER TABLE "data_imports" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "data_imports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "data_import_rows";
ALTER TABLE "data_import_rows" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "data_import_rows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "data_exports";
ALTER TABLE "data_exports" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "data_exports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "store_counters";
ALTER TABLE "store_counters" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_counters" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "pickup_locations";
ALTER TABLE "pickup_locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "pickup_locations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "shipping_zones";
ALTER TABLE "shipping_zones" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shipping_zones" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "shipping_zone_areas";
ALTER TABLE "shipping_zone_areas" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shipping_zone_areas" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "coupons";
ALTER TABLE "coupons" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "coupons" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "coupon_categories";
ALTER TABLE "coupon_categories" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "coupon_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "coupon_products";
ALTER TABLE "coupon_products" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "coupon_products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "carts";
ALTER TABLE "carts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "carts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "cart_items";
ALTER TABLE "cart_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cart_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "orders";
ALTER TABLE "orders" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "orders" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "order_items";
ALTER TABLE "order_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "order_events";
ALTER TABLE "order_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "shipments";
ALTER TABLE "shipments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shipments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "payments";
ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "coupon_redemptions";
ALTER TABLE "coupon_redemptions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "coupon_redemptions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "idempotency_keys";
ALTER TABLE "idempotency_keys" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS sp_resolve_host(text);
DROP FUNCTION IF EXISTS sp_invitation_by_token(text);
DROP FUNCTION IF EXISTS sp_store_slug_taken(text);
DROP FUNCTION IF EXISTS sp_payment_owner(text);
DROP FUNCTION IF EXISTS app_current_tenant();
DROP FUNCTION IF EXISTS app_current_user();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_app') THEN
    GRANT UPDATE, DELETE ON audit_logs TO storeplix_app;
  END IF;
END
$$;

COMMIT;
