<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Database\RlsSession;
use App\Domain\Tenancy\Exceptions\RlsMisconfiguredException;
use App\Domain\Tenancy\Support\PlatformDb;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S20 boot check (PHASE-5B-CONTRACT §2.2): with TENANCY_RLS=true the app must not connect as the schema owner.
 * Pure configuration: runs everywhere without a database connection.
 */
#[Group('tenancy')]
#[Group('security')]
class RlsBootCheckTest extends TestCase
{
    private function rlsOnPostgres(string $app, string $owner, string $admin = 'storeplix_admin'): RlsSession
    {
        config([
            'tenancy.rls' => true,
            'database.default' => 'pgsql',
            'database.connections.pgsql.username' => $app,
            'database.connections.pgsql_owner.username' => $owner,
            'database.connections.pgsql_admin.username' => $admin,
        ]);
        $this->app->detectEnvironment(fn () => 'production');

        return $this->app->make(RlsSession::class);
    }

    public function test_rls_with_the_owner_as_app_user_refuses_to_boot(): void
    {
        $this->expectException(RlsMisconfiguredException::class);

        $this->rlsOnPostgres('storeplix_owner', 'storeplix_owner')->assertNotOwner();
    }

    /** QA 5b-1 F-L3: DB_ADMIN_USERNAME unset → pgsql_admin = the app role → platform code would see nothing. */
    public function test_rls_with_the_app_role_as_platform_user_refuses_to_boot(): void
    {
        $this->expectException(RlsMisconfiguredException::class);
        $this->expectExceptionMessage('DB_ADMIN_USERNAME');

        $this->rlsOnPostgres('storeplix_app', 'storeplix_owner', 'storeplix_app')->assertNotOwner();
    }

    public function test_rls_with_a_separate_app_role_boots_and_reroutes_platform_queries(): void
    {
        $rls = $this->rlsOnPostgres('storeplix_app', 'storeplix_owner');
        $rls->assertNotOwner();

        $this->assertTrue($rls->enabled());
        $this->assertSame('pgsql_admin', PlatformDb::connectionName());

        // while migrating / seeding as the owner, platform code stays on that connection
        config(['database.default' => 'pgsql_owner']);
        $this->assertFalse($rls->enabled());
        $this->assertNull(PlatformDb::connectionName());
    }

    public function test_rls_is_inert_on_sqlite_and_when_switched_off(): void
    {
        config(['tenancy.rls' => true, 'database.default' => 'sqlite']);
        $this->assertFalse($this->app->make(RlsSession::class)->enabled(), 'sqlite ignores TENANCY_RLS');

        config(['tenancy.rls' => false, 'database.default' => 'pgsql']);
        $this->assertFalse($this->app->make(RlsSession::class)->enabled());
        $this->assertNull(PlatformDb::connectionName());
    }
}
