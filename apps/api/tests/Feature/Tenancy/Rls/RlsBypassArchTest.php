<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Middleware\ResetDatabaseTenant;
use Illuminate\Contracts\Http\Kernel;
use PHPUnit\Framework\Attributes\Group;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

/**
 * S20 arch tests (PHASE-5B-CONTRACT §2.4): every RLS bypass is greppable and lives in an allowlisted place.
 * Runs everywhere (sqlite too): it reads source files, not the database.
 */
#[Group('tenancy')]
#[Group('security')]
class RlsBypassArchTest extends TestCase
{
    /** withoutTenancy() / the admin connection: console code, seeders and the Tenancy domain only. */
    private const ALLOWED = [
        '#^app/Console/#',
        '#^app/Domain/[A-Za-z]+/Console/#',
        '#^app/Domain/Tenancy/#',
        '#^app/Domain/Admin/#', // PHASE-8-1 P8-6: the admin API reads on pgsql_admin
        '#^database/seeders/#',
    ];

    public function test_without_tenancy_and_the_admin_connection_are_used_only_in_allowlisted_places(): void
    {
        $offenders = [];
        $finder = (new Finder)->files()->name('*.php')->in([base_path('app'), base_path('database'), base_path('routes')]);

        foreach ($finder as $file) {
            $path = str_replace(base_path().'/', '', $file->getRealPath());
            $code = $file->getContents();
            $uses = preg_match('/withoutTenancy\s*\(|pgsql_admin|tenancy\.admin_connection|PlatformDb::|withoutGlobalScope\(\s*TenantScope/', $code) === 1;

            if ($uses && ! $this->allowed($path)) {
                $offenders[] = $path;
            }
        }

        $this->assertSame([], $offenders, 'RLS bypass outside the allowlist: use PreTenantLookup (request paths) or move it to console code');
    }

    public function test_the_session_reset_runs_first_for_every_request(): void
    {
        $global = $this->app->make(Kernel::class)->getGlobalMiddleware();

        $this->assertSame(ResetDatabaseTenant::class, $global[0] ?? null);
    }

    private function allowed(string $path): bool
    {
        foreach (self::ALLOWED as $pattern) {
            if (preg_match($pattern, $path) === 1) {
                return true;
            }
        }

        return false;
    }
}
