<?php

declare(strict_types=1);

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Database\RlsPolicies;
use App\Domain\Tenancy\Database\RlsTables;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * RUNBOOK §7: after the emergency switch-off, `php artisan tenancy:rls-enable` restores ENABLE + FORCE RLS and the
 * policies on every tenant table without touching data, and running it twice changes nothing.
 *
 * No RefreshDatabase on purpose: the DDL runs on the owner connection, and an open test transaction on the app
 * connection could hold locks it waits for. The database is migrated before the rls group runs (CI api-rls), and the
 * test always leaves every table re-enabled.
 */
#[Group('rls')]
class RlsReEnableTest extends TestCase
{
    use RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_rls_enable_restores_switched_off_tables_and_is_idempotent(): void
    {
        $owner = DB::connection('pgsql_owner');
        $sample = ['orders', 'tenant_users', 'audit_logs', 'shipments'];
        $before = $this->catalog();

        try {
            foreach ($sample as $table) {
                RlsPolicies::disable($owner, $table);
            }
            $off = $this->catalog();
            foreach ($sample as $table) {
                $this->assertSame([false, false, 0], $off[$table], "{$table} should be switched off");
            }

            $this->artisan('tenancy:rls-enable')->assertSuccessful();
            $this->assertSame($before, $this->catalog(), 'tenancy:rls-enable must restore the exact RLS state');

            $this->artisan('tenancy:rls-enable')->assertSuccessful();
            $this->assertSame($before, $this->catalog(), 'a second run changes nothing');
        } finally {
            foreach (RlsTables::TENANT as $table) {
                RlsPolicies::enable($owner, $table);
            }
        }
    }

    /** @return array<string, array{0: bool, 1: bool, 2: int}> enabled, forced, policy count per tenant table */
    private function catalog(): array
    {
        $rows = DB::connection('pgsql_owner')->select(
            "select c.relname, c.relrowsecurity, c.relforcerowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = current_schema() and c.relkind in ('r', 'p')"
        );
        $out = [];
        foreach ($rows as $r) {
            if (in_array($r->relname, RlsTables::TENANT, true)) {
                $out[$r->relname] = [(bool) $r->relrowsecurity, (bool) $r->relforcerowsecurity, (int) $r->policies];
            }
        }
        ksort($out);

        return $out;
    }
}
