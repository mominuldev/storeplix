<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * PHASE-8-9C §3: help tables are platform tables. The app role may only SELECT most of them, so every staff write (and
 * the feedback counters, which update `help_articles`) runs on the platform connection (`pgsql_admin` with RLS on, the
 * default connection otherwise). Help rows carry no tenant data, so this is not a tenant bypass.
 */
final class HelpDb
{
    /**
     * @template TModel of Model
     *
     * @param  class-string<TModel>  $model
     * @return Builder<TModel>
     */
    public static function query(string $model): Builder
    {
        return PlatformDb::reroute($model::query());
    }

    /**
     * @template TModel of Model
     *
     * @param  class-string<TModel>  $model
     * @return TModel
     */
    public static function make(string $model): Model
    {
        $row = new $model;
        $row->setConnection(PlatformDb::connectionName());

        return $row;
    }

    public static function connection(): ConnectionInterface
    {
        return PlatformDb::connection();
    }

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function transaction(callable $callback): mixed
    {
        return PlatformDb::connection()->transaction($callback);
    }

    public static function pgsql(): bool
    {
        return PlatformDb::connection()->getDriverName() === 'pgsql';
    }
}
