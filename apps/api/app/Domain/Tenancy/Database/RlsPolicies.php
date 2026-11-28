<?php

namespace App\Domain\Tenancy\Database;

use Illuminate\Database\ConnectionInterface;

/**
 * SQL for the row-level-security policies (PHASE-5B-CONTRACT §2.3, ADR 0012). Used by the policy migration, its
 * rollback, and every later migration that creates a tenant table (`RlsPolicies::enable($db, 'new_table')`).
 * Postgres only; callers check the driver.
 *
 * `tenant_id` columns are char(26) ULIDs, so the text GUC is cast to bpchar: `tenant_id = text` would cast the
 * column instead and lose the (tenant_id, …) indexes (§2.8).
 */
final class RlsPolicies
{
    public const APP_ROLE = 'storeplix_app';

    public const ADMIN_ROLE = 'storeplix_admin';

    public const TENANT = '(app_current_tenant())::bpchar';

    public const USER = '(app_current_user())::bpchar';

    /** Policy names per table (for drops). */
    public const NAMES = [
        'tenant_users' => ['tenant_users_membership', 'tenant_users_select', 'tenant_users_insert', 'tenant_users_update', 'tenant_users_delete'],
        'audit_logs' => ['audit_logs_select', 'audit_logs_insert'],
        'sms_credit_ledger' => ['sms_credit_ledger_select', 'sms_credit_ledger_insert'],
        'ai_credit_ledger' => ['ai_credit_ledger_select', 'ai_credit_ledger_insert'],
        'sms_messages' => ['sms_messages_select', 'sms_messages_insert', 'sms_messages_update'],
        'roles' => ['roles_select', 'roles_insert', 'roles_update', 'roles_delete'],
        'role_permissions' => ['role_permissions_select', 'role_permissions_insert', 'role_permissions_update', 'role_permissions_delete'],
    ];

    public static function roleExists(ConnectionInterface $db, string $role): bool
    {
        return $db->selectOne('select 1 as ok from pg_roles where rolname = ?', [$role]) !== null;
    }

    /** `TO storeplix_app` when the role exists (§2.1 script ran), else PUBLIC: fail closed either way. */
    public static function target(ConnectionInterface $db): string
    {
        return self::roleExists($db, self::APP_ROLE) ? self::APP_ROLE : 'public';
    }

    /** ENABLE + FORCE row level security and (re)create the table's policies. */
    public static function enable(ConnectionInterface $db, string $table, ?string $target = null): void
    {
        $target ??= self::target($db);
        $t = '"'.$table.'"';
        $tenant = self::TENANT;

        $db->statement("ALTER TABLE {$t} ENABLE ROW LEVEL SECURITY");
        $db->statement("ALTER TABLE {$t} FORCE ROW LEVEL SECURITY");
        self::dropPolicies($db, $table);

        match ($table) {
            // Membership list for /auth/me and ResolveTenant before a tenant is set (app.user_id), B2. Only READS
            // follow the user: writes are limited to the current tenant, so a user can't change or delete their
            // memberships in other tenants (QA 5b-1 F-L2).
            'tenant_users' => [
                $db->statement("CREATE POLICY tenant_users_select ON {$t} FOR SELECT TO {$target}
                    USING (tenant_id = {$tenant} OR user_id = ".self::USER.')'),
                $db->statement("CREATE POLICY tenant_users_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY tenant_users_update ON {$t} FOR UPDATE TO {$target}
                    USING (tenant_id = {$tenant}) WITH CHECK (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY tenant_users_delete ON {$t} FOR DELETE TO {$target} USING (tenant_id = {$tenant})"),
            ],
            // Platform events (tenant_id null) are insertable but readable only through pgsql_admin. No UPDATE /
            // DELETE policy (and no grant): append-only (SECURITY.md T18).
            'audit_logs' => [
                $db->statement("CREATE POLICY audit_logs_select ON {$t} FOR SELECT TO {$target} USING (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY audit_logs_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id IS NULL OR tenant_id = {$tenant})"),
            ],
            // PHASE-8-9A §3.1: the SMS credit ledger is append-only like audit_logs (no UPDATE / DELETE policy or grant).
            'sms_credit_ledger' => [
                $db->statement("CREATE POLICY sms_credit_ledger_select ON {$t} FOR SELECT TO {$target} USING (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY sms_credit_ledger_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id = {$tenant})"),
            ],
            // PHASE-8-9D §3.2: the AI credit ledger is append-only too.
            'ai_credit_ledger' => [
                $db->statement("CREATE POLICY ai_credit_ledger_select ON {$t} FOR SELECT TO {$target} USING (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY ai_credit_ledger_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id = {$tenant})"),
            ],
            // Account-level OTP SMS (tenant_id null) are written before any tenant exists and their status is
            // updated by the SendSms job without a tenant. Postgres applies the SELECT policy to an UPDATE's WHERE,
            // so the null-tenant rows are also selectable while no tenant is set (never across tenants).
            'sms_messages' => [
                $db->statement("CREATE POLICY sms_messages_select ON {$t} FOR SELECT TO {$target}
                    USING (tenant_id = {$tenant} OR (tenant_id IS NULL AND {$tenant} IS NULL))"),
                $db->statement("CREATE POLICY sms_messages_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id IS NULL OR tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY sms_messages_update ON {$t} FOR UPDATE TO {$target}
                    USING (tenant_id = {$tenant} OR (tenant_id IS NULL AND {$tenant} IS NULL))
                    WITH CHECK (tenant_id = {$tenant} OR (tenant_id IS NULL AND {$tenant} IS NULL))"),
            ],
            // PHASE-8-3 §5.1: /auth/me lists the role (and its permissions) of every membership without a tenant
            // context, so READS follow the user's memberships like tenant_users; writes stay in the current tenant.
            'roles', 'role_permissions' => [
                $db->statement("CREATE POLICY {$table}_select ON {$t} FOR SELECT TO {$target}
                    USING (tenant_id = {$tenant} OR tenant_id IN (SELECT tu.tenant_id FROM tenant_users tu WHERE tu.user_id = ".self::USER.'))'),
                $db->statement("CREATE POLICY {$table}_insert ON {$t} FOR INSERT TO {$target} WITH CHECK (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY {$table}_update ON {$t} FOR UPDATE TO {$target}
                    USING (tenant_id = {$tenant}) WITH CHECK (tenant_id = {$tenant})"),
                $db->statement("CREATE POLICY {$table}_delete ON {$t} FOR DELETE TO {$target} USING (tenant_id = {$tenant})"),
            ],
            default => $db->statement(
                "CREATE POLICY tenant_isolation ON {$t} FOR ALL TO {$target}
                   USING (tenant_id = {$tenant}) WITH CHECK (tenant_id = {$tenant})"
            ),
        };
    }

    /** Drop the policies, NO FORCE, DISABLE. */
    public static function disable(ConnectionInterface $db, string $table): void
    {
        self::dropPolicies($db, $table);
        $t = '"'.$table.'"';
        $db->statement("ALTER TABLE {$t} NO FORCE ROW LEVEL SECURITY");
        $db->statement("ALTER TABLE {$t} DISABLE ROW LEVEL SECURITY");
    }

    private static function dropPolicies(ConnectionInterface $db, string $table): void
    {
        foreach ([...(self::NAMES[$table] ?? []), 'tenant_isolation'] as $name) {
            $db->statement("DROP POLICY IF EXISTS {$name} ON \"{$table}\"");
        }
    }
}
