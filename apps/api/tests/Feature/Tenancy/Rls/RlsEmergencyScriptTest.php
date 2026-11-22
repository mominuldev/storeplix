<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Database\RlsPolicies;
use App\Domain\Tenancy\Database\RlsTables;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * QA 5b-1 F-L6 / F-L7: database/sql/rls-emergency-off.sql switches RLS off on exactly RlsTables::TENANT (every policy
 * name dropped) and keeps the definer functions the running app still calls. Reads the file: runs everywhere.
 */
#[Group('tenancy')]
#[Group('security')]
class RlsEmergencyScriptTest extends TestCase
{
    private function script(): string
    {
        return (string) file_get_contents(base_path('database/sql/rls-emergency-off.sql'));
    }

    public function test_the_table_list_equals_rls_tables_tenant(): void
    {
        preg_match_all('/^-- table: ([a-z_]+)$/m', $this->script(), $m);

        $this->assertSame(RlsTables::TENANT, $m[1]);
    }

    public function test_every_table_drops_all_its_policies_and_disables_rls(): void
    {
        $sql = $this->script();
        foreach (RlsTables::TENANT as $table) {
            foreach ([...(RlsPolicies::NAMES[$table] ?? []), 'tenant_isolation'] as $policy) {
                $this->assertStringContainsString("DROP POLICY IF EXISTS {$policy} ON \"{$table}\";", $sql);
            }
            $this->assertStringContainsString("ALTER TABLE \"{$table}\" NO FORCE ROW LEVEL SECURITY;", $sql);
            $this->assertStringContainsString("ALTER TABLE \"{$table}\" DISABLE ROW LEVEL SECURITY;", $sql);
        }
    }

    public function test_the_definer_functions_are_kept(): void
    {
        $this->assertDoesNotMatchRegularExpression('/DROP\s+FUNCTION/i', $this->script());
        $migration = (string) file_get_contents(base_path('database/migrations/2026_06_01_000100_enable_row_level_security.php'));
        $down = substr($migration, (int) strpos($migration, 'public function down()'));
        $this->assertDoesNotMatchRegularExpression('/DROP FUNCTION/', substr($down, 0, (int) strpos($down, 'private function')));
    }
}
