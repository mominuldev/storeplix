<?php

namespace Tests\Support;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;

/**
 * Postgres race-test harness (QA phase-5a F-M2). parallel() commits the test's data (RefreshDatabase transactions
 * are invisible to other connections), forks N children that each open their OWN database, Redis and cache
 * connections, and collects one result per child. raceCleanup() truncates everything the test committed, so later
 * tests in the same process (e.g. `security (postgres)`) start from an empty database again. Use both as:
 *
 *     try { $results = $this->parallel(...); ... } finally { $this->raceCleanup(); }
 */
trait ForksRaces
{
    protected function requirePostgresRace(): void
    {
        if (DB::getDriverName() !== 'pgsql' || ! function_exists('pcntl_fork')) {
            $this->markTestSkipped('Needs Postgres + pcntl (CI race / perf job).');
        }
    }

    /**
     * Runs $fn($i) in $n forked children; returns what each child returned (an HTTP status), or 500 on a throw.
     *
     * @return list<int>
     */
    protected function parallel(int $n, callable $fn): array
    {
        // RLS mode (api-rls) has no wrapping test transaction (TestCase::setUpTraits): nothing to commit or reopen.
        $transacting = DB::transactionLevel() > 0;
        if ($transacting) {
            DB::commit();
        }
        $files = [];
        $pids = [];
        for ($i = 0; $i < $n; $i++) {
            $file = (string) tempnam(sys_get_temp_dir(), 'race');
            $files[] = $file;
            $pid = pcntl_fork();
            if ($pid === 0) {
                $this->reconnectAfterFork();
                try {
                    $result = (string) $fn($i);
                } catch (\Throwable) {
                    $result = '500';
                }
                file_put_contents($file, $result);
                // Leave without running shutdown handlers / destructors: they would close the parent's sockets.
                function_exists('posix_kill') ? posix_kill(getmypid(), SIGKILL) : exit(0);
            }
            $pids[] = $pid;
        }
        foreach ($pids as $pid) {
            pcntl_waitpid($pid, $status);
        }
        if ($transacting) {
            DB::beginTransaction();
        }

        $results = array_map(fn ($f) => (int) file_get_contents($f), $files);
        array_map('unlink', $files);

        return $results;
    }

    /** Truncates every table the race committed (all but migrations and the seeded plans) and reopens the test transaction. */
    protected function raceCleanup(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        // With RLS on the app role has no TRUNCATE right: truncate as the schema owner (PHASE-5B-CONTRACT §2.6).
        $rls = $this->rlsActive();
        $db = $rls ? DB::connection((string) config('tenancy.owner_connection')) : DB::connection();
        // Guard: this TRUNCATEs every table. Only ever on a dedicated test database (CI: storeplix_test, storeplix_perf,
        // storeplix_rls_test).
        $database = (string) $db->getDatabaseName();
        if (! app()->environment('testing') || ! preg_match('/_(test|testing|perf)$/', $database)) {
            throw new \RuntimeException("raceCleanup() refuses to truncate database \"{$database}\": needs APP_ENV=testing and a name ending in _test, _testing or _perf.");
        }
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        $tables = array_map(fn ($r) => '"'.$r->tablename.'"', $db->select(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename NOT IN ('migrations', 'plans')"
        ));
        if ($tables !== []) {
            $db->statement('TRUNCATE TABLE '.implode(', ', $tables).' RESTART IDENTITY CASCADE');
        }
        Cache::flush();
        if (! $rls) {
            DB::beginTransaction();
        }
    }

    /** Child process: never reuse the parent's DB / Redis sockets (interleaved replies → flakes). */
    private function reconnectAfterFork(): void
    {
        DB::purge();
        DB::reconnect();
        if (app()->bound('redis')) {
            app()->forgetInstance('redis');
            Redis::clearResolvedInstances();
        }
        app('cache')->forgetDriver();
        app()->forgetInstance('cache.store');
        Cache::clearResolvedInstances();
    }
}
