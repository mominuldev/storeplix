<?php

namespace App\Domain\Tenancy\Database;

use App\Domain\Tenancy\Exceptions\RlsMisconfiguredException;
use App\Domain\Tenancy\Exceptions\TenantSwitchInTransaction;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Database\Connection;

/**
 * Keeps the Postgres session variables of the app connection in step with the TenantContext and the signed-in
 * user (PHASE-5B-CONTRACT §2.5, ADR 0012):
 *
 *   app.tenant_id = TenantContext::id()   (set / run / clear)
 *   app.user_id   = the authenticated merchant (SetDatabaseUser, Authenticated / Login / Logout)
 *
 * Both are reset at request start, at job start and after each job, and re-applied whenever Laravel opens or
 * re-opens the connection (ConnectionEstablished). Only an already-open connection is written to: a connection
 * opened later gets the current state from the ConnectionEstablished listener.
 *
 * Inert unless TENANCY_RLS=true AND the default connection is Postgres (not the owner/admin connection).
 */
final class RlsSession
{
    private ?string $userId = null;

    public function __construct(private readonly Application $app) {}

    public function enabled(): bool
    {
        if (! (bool) config('tenancy.rls')) {
            return false;
        }

        $name = $this->connectionName();

        return config("database.connections.{$name}.driver") === 'pgsql'
            && ! in_array($name, [config('tenancy.owner_connection'), config('tenancy.admin_connection')], true);
    }

    /** The app connection = the default connection. */
    public function connectionName(): string
    {
        return (string) config('database.default');
    }

    public function userId(): ?string
    {
        return $this->userId;
    }

    /**
     * Refuses to switch to a DIFFERENT tenant inside an open transaction: a rollback would silently restore the
     * previous app.tenant_id while the TenantContext keeps the new one.
     */
    public function assertCanSwitch(?string $from, ?string $to): void
    {
        if ($from === null || $to === null || $from === $to) {
            return;
        }

        $connection = $this->openConnection();

        if ($connection !== null && $connection->transactionLevel() > 0) {
            throw new TenantSwitchInTransaction($from, $to);
        }
    }

    public function applyTenant(?string $tenantId): void
    {
        $this->openConnection()?->statement("select set_config('app.tenant_id', ?, false)", [$tenantId ?? '']);
    }

    public function setUser(?string $userId): void
    {
        $this->userId = $userId;
        $this->openConnection()?->statement("select set_config('app.user_id', ?, false)", [$userId ?? '']);
    }

    /** Request / job boundary: forget the user and write both GUCs from the current state. */
    public function reset(): void
    {
        $this->userId = null;
        $this->write($this->openConnection());
    }

    /** ConnectionEstablished (new connection, reconnect, forked child): apply the current state + role check. */
    public function connected(Connection $connection, string $name): void
    {
        if (! $this->enabled() || $name !== $this->connectionName()) {
            return;
        }

        $row = $connection->selectOne(
            "select set_config('app.tenant_id', ?, false) as tenant_id, set_config('app.user_id', ?, false) as user_id,
                    (select r.rolsuper from pg_roles r where r.rolname = current_user) as rolsuper,
                    (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as rolbypassrls",
            [$this->tenantId() ?? '', $this->userId ?? ''],
            false,
        );

        // §2.2 boot check, second half: a superuser or BYPASSRLS role would make every policy decorative.
        // Inside `testing` RlsCoverageTest asserts the same thing instead (a failing test in api-rls).
        if ($row !== null && ($row->rolsuper || $row->rolbypassrls) && ! $this->app->environment('testing')) {
            throw new RlsMisconfiguredException('TENANCY_RLS=true but the app connects as a superuser or BYPASSRLS role.');
        }
    }

    /**
     * §2.2 boot check, first half (no query): with RLS on, DB_USERNAME must not be the schema owner.
     */
    public function assertNotOwner(): void
    {
        if (! $this->enabled() || $this->app->environment('testing')) {
            return;
        }

        $app = config('database.connections.'.$this->connectionName().'.username');
        $owner = config('database.connections.'.config('tenancy.owner_connection').'.username');

        if ($app === $owner) {
            throw new RlsMisconfiguredException('TENANCY_RLS=true but DB_USERNAME is the schema owner (set DB_OWNER_USERNAME to a different role).');
        }
    }

    private function write(?Connection $connection): void
    {
        $connection?->statement(
            "select set_config('app.tenant_id', ?, false), set_config('app.user_id', ?, false)",
            [$this->tenantId() ?? '', $this->userId ?? ''],
        );
    }

    private function tenantId(): ?string
    {
        return $this->app->make(TenantContext::class)->id();
    }

    private function openConnection(): ?Connection
    {
        if (! $this->enabled()) {
            return null;
        }

        $connection = $this->app['db']->getConnections()[$this->connectionName()] ?? null;

        return $connection instanceof Connection ? $connection : null;
    }
}
