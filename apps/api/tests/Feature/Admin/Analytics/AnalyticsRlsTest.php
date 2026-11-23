<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\AnalyticsFixtures;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/** PHASE-8-2 S84 (§10 `rls` group): the app role can't read either analytics table; the night job works with RLS on. */
#[Group('analytics')]
#[Group('rls')]
#[Group('security')]
class AnalyticsRlsTest extends TestCase
{
    use AnalyticsFixtures, RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_the_app_role_has_no_privilege_on_the_analytics_tables(): void
    {
        $t = $this->aTenant('Rls', '2026-09-01 10:00');
        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate(); // console path: pgsql_admin, RLS on
        $this->assertSame(7, $this->platformTable('platform_daily_metrics')->count());
        $this->assertNotNull($this->tenantRow($t, '2026-11-22'));

        $this->setGuc($t);
        foreach (['tenant_daily_metrics', 'platform_daily_metrics'] as $table) {
            $this->assertSame('42501', $this->sqlState(fn () => DB::table($table)->count()), "{$table}: SELECT as the app role");
            $this->assertSame('42501', $this->sqlState(fn () => DB::table($table)->where('day', '2026-11-22')->delete()), "{$table}: DELETE as the app role");
        }

        $catalog = DB::connection(config('tenancy.owner_connection'))->selectOne(
            "select c.relrowsecurity, c.relforcerowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
               from pg_class c where c.relname = 'tenant_daily_metrics'");
        $this->assertTrue((bool) $catalog->relrowsecurity);
        $this->assertTrue((bool) $catalog->relforcerowsecurity);
        $this->assertGreaterThan(0, (int) $catalog->policies);
    }
}
