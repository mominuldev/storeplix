<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

/**
 * The explicit cross-tenant bypass (PHASE-5B-CONTRACT P5B-4, §2.4 B10/B11/B14/B15).
 *
 * With RLS on, platform code (console commands, the scheduler, platform jobs, future /admin/*) reads and writes
 * through `pgsql_admin` (BYPASSRLS). Request paths never use it: they resolve a tenant through a SECURITY DEFINER
 * function and then run inside TenantContext::run(). An arch test allowlists the call sites.
 *
 * With RLS off (sqlite, dev, the owner-run api-postgres job), or while the default connection is already the
 * owner (migrate / db:seed --database=pgsql_owner), this is the default connection, exactly as before 5b.
 */
final class PlatformDb
{
    /** null = the default connection. */
    public static function connectionName(): ?string
    {
        if (! app(RlsSession::class)->enabled()) {
            return null;
        }

        return (string) config('tenancy.admin_connection');
    }

    public static function connection(): ConnectionInterface
    {
        return DB::connection(self::connectionName());
    }

    /**
     * Moves an Eloquent builder (and its model) onto the platform connection.
     *
     * @template TBuilder of Builder
     *
     * @param  TBuilder  $builder
     * @return TBuilder
     */
    public static function reroute(Builder $builder): Builder
    {
        $name = self::connectionName();

        if ($name === null) {
            return $builder;
        }

        $connection = DB::connection($name);
        $builder->getModel()->setConnection($name);
        $query = $builder->getQuery();
        $query->connection = $connection;
        $query->grammar = $connection->getQueryGrammar();
        $query->processor = $connection->getPostProcessor();

        return $builder;
    }
}
