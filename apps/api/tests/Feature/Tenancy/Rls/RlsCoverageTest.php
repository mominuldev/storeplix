<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Database\RlsTables;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S20 (PHASE-5B-CONTRACT §2.6): no silent RLS gaps. Compares the catalog with RlsTables, so a new table with a
 * tenant_id column fails here until it gets a forced policy.
 */
#[Group('rls')]
#[Group('tenancy')]
class RlsCoverageTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_every_table_with_tenant_id_is_listed_and_has_forced_rls_with_a_policy(): void
    {
        // pg_catalog, not information_schema: the latter hides tables the app role has no privilege on (PHASE-8-2 S84).
        $withTenantId = collect(DB::select(
            "select distinct c.relname as table_name from pg_attribute a
               join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = current_schema() and c.relkind in ('r', 'p') and a.attname = 'tenant_id' and not a.attisdropped"
        ))->pluck('table_name')->sort()->values()->all();

        $listed = collect(RlsTables::TENANT)->sort()->values()->all();
        $this->assertSame($listed, $withTenantId, 'RlsTables::TENANT must list exactly the tables with a tenant_id column');

        $catalog = collect(DB::select(
            "select c.relname, c.relrowsecurity, c.relforcerowsecurity,
                    (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = current_schema() and c.relkind in ('r', 'p')"
        ))->keyBy('relname');

        foreach (RlsTables::TENANT as $table) {
            $row = $catalog->get($table);
            $this->assertNotNull($row, "{$table} does not exist");
            $this->assertTrue((bool) $row->relrowsecurity, "{$table}: ROW LEVEL SECURITY not enabled");
            $this->assertTrue((bool) $row->relforcerowsecurity, "{$table}: ROW LEVEL SECURITY not forced");
            $this->assertGreaterThan(0, (int) $row->policies, "{$table}: no policy");
        }
    }

    public function test_every_table_is_classified_as_tenant_or_platform(): void
    {
        $tables = collect(DB::select('select tablename from pg_tables where schemaname = current_schema()'))->pluck('tablename');
        $unclassified = $tables->diff([...RlsTables::TENANT, ...RlsTables::PLATFORM])->values()->all();

        $this->assertSame([], $unclassified, 'add new tables to RlsTables::TENANT (with RLS) or ::PLATFORM');
        $this->assertSame([], array_values(array_intersect(RlsTables::TENANT, RlsTables::PLATFORM)));
    }

    public function test_policies_check_writes_and_target_the_app_role(): void
    {
        $policies = collect(DB::select(
            'select tablename, policyname, cmd, roles::text as roles, qual, with_check
               from pg_policies where schemaname = current_schema()'
        ));

        foreach (array_diff(RlsTables::TENANT, RlsTables::SPECIAL) as $table) {
            $p = $policies->where('tablename', $table)->where('policyname', 'tenant_isolation')->first();
            $this->assertNotNull($p, "{$table}: tenant_isolation policy missing");
            $this->assertSame('ALL', $p->cmd);
            $this->assertStringContainsString('app_current_tenant()', (string) $p->qual);
            $this->assertStringContainsString('app_current_tenant()', (string) $p->with_check, "{$table}: policy has no WITH CHECK");
            $this->assertStringContainsString('storeplix_app', (string) $p->roles);
        }

        $this->assertSame(['DELETE', 'INSERT', 'SELECT', 'UPDATE'], $policies->where('tablename', 'tenant_users')->pluck('cmd')->sort()->values()->all());
        $this->assertSame(['INSERT', 'SELECT'], $policies->where('tablename', 'audit_logs')->pluck('cmd')->sort()->values()->all());
        $this->assertSame(['INSERT', 'SELECT', 'UPDATE'], $policies->where('tablename', 'sms_messages')->pluck('cmd')->sort()->values()->all());
    }

    public function test_the_app_connects_as_a_role_that_cannot_bypass_rls(): void
    {
        $role = DB::selectOne('select current_user as name, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user');

        $this->assertFalse((bool) $role->rolsuper, "the app connects as superuser {$role->name}");
        $this->assertFalse((bool) $role->rolbypassrls, "the app role {$role->name} has BYPASSRLS");
        $this->assertNotSame(
            config('database.connections.'.config('tenancy.owner_connection').'.username'),
            config('database.connections.'.config('database.default').'.username'),
            'DB_USERNAME must not be the schema owner with TENANCY_RLS=true',
        );
        // the app role owns no table (an owner without FORCE would bypass its own policies)
        $this->assertSame(0, (int) DB::selectOne('select count(*) as c from pg_tables where schemaname = current_schema() and tableowner = current_user')->c);
    }

    public function test_the_admin_connection_bypasses_rls_for_platform_code(): void
    {
        $role = DB::connection(config('tenancy.admin_connection'))
            ->selectOne('select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user');

        $this->assertTrue((bool) $role->rolbypassrls || (bool) $role->rolsuper);
    }
}
