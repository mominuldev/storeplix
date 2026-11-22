<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Console;

use App\Domain\Tenancy\Database\RlsPolicies;
use App\Domain\Tenancy\Database\RlsTables;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Re-enable row-level security after `database/sql/rls-emergency-off.sql` (RUNBOOK §7, ADR 0012): ENABLE + FORCE RLS
 * and recreate the policies of every RlsTables::TENANT table, in one transaction, as the schema owner. Idempotent
 * (RlsPolicies::enable drops before it creates), keeps all data, and never touches the definer functions. Then set
 * TENANCY_RLS=true and restart web + workers.
 */
class EnableRowLevelSecurity extends Command
{
    protected $signature = 'tenancy:rls-enable {--database=pgsql_owner : Connection of the schema owner}';

    protected $description = 'Re-apply forced row-level security and policies to every tenant table (after the emergency switch-off)';

    public function handle(): int
    {
        $db = DB::connection((string) $this->option('database'));
        if ($db->getDriverName() !== 'pgsql') {
            $this->error('Row-level security exists only on Postgres.');

            return self::FAILURE;
        }

        $done = [];
        $missing = [];
        $db->transaction(function () use ($db, &$done, &$missing) {
            foreach (RlsTables::TENANT as $table) {
                if ($db->selectOne('select to_regclass(?) as t', ['public.'.$table])?->t === null) {
                    $missing[] = $table;

                    continue;
                }
                RlsPolicies::enable($db, $table);
                $done[] = $table;
            }
            // audit_logs stays append-only for the app role (SECURITY.md T18), whichever way RLS was switched off.
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('REVOKE UPDATE, DELETE ON audit_logs FROM '.RlsPolicies::APP_ROLE);
            }
        });

        $this->info(sprintf('Row-level security enabled and forced on %d tables.', count($done)));
        if ($missing !== []) {
            $this->warn('Not created yet (skipped): '.implode(', ', $missing));
        }
        $this->line('Next: set TENANCY_RLS=true and restart the web and queue processes.');

        return self::SUCCESS;
    }
}
