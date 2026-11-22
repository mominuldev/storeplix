<?php

namespace Tests;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Database\RlsSession;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Foundation\Testing\RefreshDatabaseState;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

abstract class TestCase extends BaseTestCase
{
    /**
     * RefreshDatabase transacts on the default connection, except with RLS on (see setUpTraits()).
     *
     * @var list<string|null>
     */
    protected array $connectionsToTransact = [null];

    /** @var list<string>|null tables truncated between RLS-mode tests (cached per process) */
    private static ?array $rlsTruncateTables = null;

    /** @var list<array<string, mixed>>|null the migration-seeded plans, restored before every RLS-mode test */
    private static ?array $rlsPlans = null;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests(); // no real network calls from tests
    }

    /**
     * Phase 5b (PHASE-5B-CONTRACT §2.6), RLS mode = TENANCY_RLS=true on Postgres with the app connected as
     * storeplix_app (CI `api-rls`):
     *  - migrations run on `pgsql_owner` (the app role can't create or drop tables), once per process;
     *  - tests do NOT run inside a wrapping transaction: platform code reads through `pgsql_admin` (withoutTenancy,
     *    console commands), another session that can't see uncommitted rows. Instead every table is truncated
     *    (on the owner connection) before each test, like the race tests already do.
     * Everywhere else (sqlite, the owner-run api-postgres job) RefreshDatabase behaves exactly as before.
     */
    protected function setUpTraits()
    {
        if (isset(class_uses_recursive(static::class)[RefreshDatabase::class]) && $this->app->make(RlsSession::class)->enabled()) {
            $this->connectionsToTransact = [];
            $owner = (string) config('tenancy.owner_connection');

            if (! RefreshDatabaseState::$migrated) {
                $this->app[Kernel::class]->call('migrate:fresh', ['--database' => $owner, '--force' => true]);
                $this->app[Kernel::class]->setArtisan(null);
                RefreshDatabaseState::$migrated = true;
                self::$rlsTruncateTables = null;
                self::$rlsPlans = null;
            }

            $this->truncateForRls($owner);
        }

        return parent::setUpTraits();
    }

    /**
     * All tables but `migrations`, on the owner connection (TRUNCATE right); the migration-seeded `plans` are put
     * back as they were right after migrating (a test may re-seed them, as a rolled-back transaction would undo).
     */
    private function truncateForRls(string $owner): void
    {
        $db = DB::connection($owner);
        $database = (string) $db->getDatabaseName();
        if (! preg_match('/_(test|testing|perf)$/', $database)) {
            throw new \RuntimeException("Refusing to truncate database \"{$database}\" between RLS tests: the name must end in _test, _testing or _perf.");
        }

        self::$rlsPlans ??= $db->table('plans')->orderBy('id')->get()->map(fn ($row) => (array) $row)->all();
        self::$rlsTruncateTables ??= array_map(fn ($r) => '"'.$r->tablename.'"', $db->select(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'migrations'"
        ));

        if (self::$rlsTruncateTables !== []) {
            $db->statement('TRUNCATE TABLE '.implode(', ', self::$rlsTruncateTables).' RESTART IDENTITY CASCADE');
        }
        if (self::$rlsPlans !== []) {
            $db->table('plans')->insert(self::$rlsPlans);
        }
    }

    /** True when the suite runs as storeplix_app with TENANCY_RLS=true on Postgres (CI `api-rls`). */
    protected function rlsActive(): bool
    {
        return $this->app->make(RlsSession::class)->enabled();
    }

    /**
     * Test-side cross-tenant reads/writes of rows outside any tenant context (audit_logs, sms_messages, raw tables):
     * the BYPASSRLS `pgsql_admin` connection in RLS mode, the default connection otherwise.
     *
     * @template TModel of \Illuminate\Database\Eloquent\Model
     *
     * @param  class-string<TModel>  $model
     * @return Builder<TModel>
     */
    protected function platformQuery(string $model): Builder
    {
        $name = PlatformDb::connectionName();

        return $name === null ? $model::query() : $model::on($name);
    }

    protected function platformTable(string $table): \Illuminate\Database\Query\Builder
    {
        return PlatformDb::connection()->table($table);
    }

    /**
     * Fixture helper (§2.6): writes / reads tenant rows inside the tenant, as the database policies require.
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    protected function inTenant(Tenant|string $tenant, callable $callback): mixed
    {
        return $this->tenancy()->run($tenant, $callback);
    }

    /**
     * Every test request starts with fresh auth guards, like a real HTTP request
     * (otherwise Sanctum's guard keeps the first resolved user across requests).
     */
    public function call($method, $uri, $parameters = [], $cookies = [], $files = [], $server = [], $content = null)
    {
        $this->app['auth']->forgetGuards();

        // Test-only acting user (tenantHeaders): Phase 4.7c removed Bearer tokens, so merchant requests in feature
        // tests authenticate like Sanctum::actingAs on the web guard. The header never reaches app code.
        $actingAs = $server['HTTP_X_TESTING_USER'] ?? null;
        unset($server['HTTP_X_TESTING_USER']);
        if (is_string($actingAs) && ($user = User::query()->find($actingAs)) !== null) {
            $this->actingAs($user, 'web');
        }

        // Sign-in endpoints are stateful-only (4.7c): unless a test sets Referer/Origin itself, requests come from the
        // merchant SPA origin, like the real same-origin app. Tests of non-SPA callers send their own Origin.
        if (! isset($server['HTTP_REFERER']) && ! isset($server['HTTP_ORIGIN']) && $actingAs === null) {
            $server['HTTP_REFERER'] = 'http://localhost:5173/';
        }

        return parent::call($method, $uri, $parameters, $cookies, $files, $server, $content);
    }

    /**
     * @return array{0: User, 1: Tenant}
     */
    protected function merchant(string $role = TenantUser::ROLE_OWNER, ?Tenant $tenant = null): array
    {
        $user = User::factory()->create();
        $tenant ??= Tenant::factory()->create();

        $this->inTenant($tenant, fn () => TenantUser::query()->create(['tenant_id' => $tenant->id, 'user_id' => $user->id, 'role' => $role]));

        return [$user, $tenant];
    }

    /**
     * @param  list<string>  $extraHosts
     */
    protected function storeFor(Tenant $tenant, string $slug, array $extraHosts = [], string $status = Store::STATUS_ACTIVE): Store
    {
        return app(StoreProvisioner::class)->provision($tenant, [
            'name' => ucfirst($slug).' Store',
            'slug' => $slug,
            'status' => $status,
        ], $extraHosts);
    }

    /**
     * @return array<string, string>
     */
    protected function tenantHeaders(User $user, Tenant|string $tenant): array
    {
        return [
            'X-Testing-User' => $user->id,
            'X-Tenant-Id' => $tenant instanceof Tenant ? $tenant->id : $tenant,
        ];
    }

    /** Real image bytes generated with GD. */
    protected function imageBytes(int $width, int $height, string $format = 'png'): string
    {
        $img = imagecreatetruecolor($width, $height);
        imagefill($img, 0, 0, imagecolorallocate($img, 91, 83, 255));
        ob_start();
        match ($format) {
            'png' => imagepng($img),
            'jpeg' => imagejpeg($img),
            'webp' => imagewebp($img),
            'gif' => imagegif($img),
        };
        imagedestroy($img);

        return (string) ob_get_clean();
    }

    protected function tenancy(): TenantContext
    {
        return app(TenantContext::class);
    }
}
