<?php

namespace App\Domain\Tenancy;

use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Auth\Events\Authenticated;
use Illuminate\Auth\Events\Login;
use Illuminate\Auth\Events\Logout;
use Illuminate\Database\Events\ConnectionEstablished;
use Illuminate\Database\Events\MigrationsStarted;
use Illuminate\Database\Events\TransactionRolledBack;
use Illuminate\Queue\Events\JobExceptionOccurred;
use Illuminate\Queue\Events\JobFailed;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\ServiceProvider;

class TenancyServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Scoped: flushed between requests (Octane) and between queue jobs.
        $this->app->scoped(TenantContext::class);

        // Phase 5b (RLS): GUC state of the app connection. Reset explicitly at request/job boundaries.
        $this->app->singleton(RlsSession::class);
    }

    public function boot(): void
    {
        // Capture the current tenant into every queued payload. TenantAware jobs restore it
        // through the RestoreTenantContext job middleware.
        Queue::createPayloadUsing(function (?string $connection, ?string $queue, array $payload): array {
            $tenantId = $this->app->make(TenantContext::class)->id();

            return $tenantId !== null ? ['tenant_id' => $tenantId] : [];
        });

        $this->bootRowLevelSecurity();

        if ($this->app->runningInConsole()) {
            $this->commands([Console\EnableRowLevelSecurity::class]);
            Event::listen(MigrationsStarted::class, fn (MigrationsStarted $e) => $this->dropStaleResolveHost($e));
        }
    }

    /**
     * Functions survive `migrate:fresh` (it drops tables only). 2026_09_01_000200 changed the result type of
     * sp_resolve_host, so the merged 2026_06_01_000100 (CREATE OR REPLACE with the old type, forward-only, not
     * editable) fails on a re-migrated Postgres database. Drop the leftover only when that migration is about to
     * run, i.e. on a fresh or new database; an already-migrated one (production) is never touched.
     */
    private function dropStaleResolveHost(MigrationsStarted $event): void
    {
        $db = DB::connection();
        if ($event->method !== 'up' || ($event->options['pretend'] ?? false) || $db->getDriverName() !== 'pgsql') {
            return;
        }

        $ran = $this->app->make('migrator')->getRepository()->getRan();
        if (! in_array('2026_06_01_000100_enable_row_level_security', $ran, true)) {
            $db->statement('DROP FUNCTION IF EXISTS sp_resolve_host(text)');
        }
    }

    /** PHASE-5B-CONTRACT §2.2 / §2.5 (all inert unless TENANCY_RLS=true on Postgres). */
    private function bootRowLevelSecurity(): void
    {
        $rls = fn (): RlsSession => $this->app->make(RlsSession::class);

        // Boot check: the app must not connect as the schema owner (the superuser/BYPASSRLS half runs on connect).
        $rls()->assertNotOwner();

        // New connection, reconnect, forked race child: re-apply the current tenant + user.
        Event::listen(ConnectionEstablished::class, fn (ConnectionEstablished $e) => $rls()->connected($e->connection, $e->connectionName));

        // QA 5b-1 F-L1: a rollback (or rollback to a savepoint) restores the GUC values of the transaction start, e.g.
        // `set(A)` inside a transaction that then rolls back. Re-apply the current state so it never drifts.
        Event::listen(TransactionRolledBack::class, fn (TransactionRolledBack $e) => $rls()->rolledBack($e->connectionName));

        // B2: app.user_id follows the signed-in user (session guard events; SetDatabaseUser covers auth:sanctum).
        Event::listen(Authenticated::class, fn (Authenticated $e) => $rls()->setUser((string) $e->user->getAuthIdentifier()));
        Event::listen(Login::class, fn (Login $e) => $rls()->setUser((string) $e->user->getAuthIdentifier()));
        Event::listen(Logout::class, fn () => $rls()->setUser(null));

        // B9: a worker starts and ends every job with empty GUCs (the scoped TenantContext is fresh per job and
        // RestoreTenantContext → run() sets the job's tenant). Sync jobs run nested inside the dispatching
        // request/command and keep its state: run() restores it in `finally`.
        $boundary = function (object $event) use ($rls): void {
            if (($event->connectionName ?? null) !== 'sync') {
                $rls()->reset();
            }
        };
        Event::listen(JobProcessing::class, $boundary);
        Event::listen(JobProcessed::class, $boundary);
        Event::listen(JobFailed::class, $boundary);
        Event::listen(JobExceptionOccurred::class, $boundary);
    }
}
