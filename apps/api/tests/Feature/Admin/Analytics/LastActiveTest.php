<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-2 P82-16, S88: `tenants.last_active_at` follows merchant-surface requests, 15-minute resolution. */
#[Group('analytics')]
#[Group('security')]
class LastActiveTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, SpaBrowser;

    private function lastActive(Tenant $tenant): ?string
    {
        $value = $this->platformTable('tenants')->where('id', $tenant->id)->value('last_active_at');

        return $value === null ? null : (string) $value;
    }

    public function test_a_merchant_request_sets_it_at_most_once_per_fifteen_minutes(): void
    {
        [$owner, $tenant] = $this->shop();
        $this->platformTable('tenants')->where('id', $tenant->id)->update(['last_active_at' => null]);
        Cache::flush(); // no throttle key left over from the fixture
        $this->travelTo(now()->startOfMinute());
        $this->flushHeaders()->getJson('/api/v1/stores', $this->tenantHeaders($owner, $tenant))->assertOk();
        $first = $this->lastActive($tenant);
        $this->assertNotNull($first);

        $this->travel(10)->minutes();
        $this->flushHeaders()->getJson('/api/v1/stores', $this->tenantHeaders($owner, $tenant))->assertOk();
        $this->assertSame($first, $this->lastActive($tenant));

        $this->travel(6)->minutes();
        $this->flushHeaders()->getJson('/api/v1/stores', $this->tenantHeaders($owner, $tenant))->assertOk();
        $this->assertNotSame($first, $this->lastActive($tenant));

        // a refused tenant header changes nothing
        [$other] = $this->merchant();
        $this->travel(20)->minutes();
        $before = $this->lastActive($tenant);
        $this->flushHeaders()->getJson('/api/v1/stores', $this->tenantHeaders($other, $tenant))->assertForbidden();
        $this->assertSame($before, $this->lastActive($tenant));
    }

    /** S88: impersonation does not count as merchant activity. */
    public function test_an_impersonated_request_leaves_it_unchanged(): void
    {
        $this->useSpaBrowser();
        Mail::fake();
        [, $tenant, $store] = $this->shop();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        $this->platformTable('tenants')->where('id', $tenant->id)->update(['last_active_at' => null]);
        Cache::flush(); // no throttle key left over from the fixture

        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: last active check', 'ZD-9', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $this->browser('GET', "/api/v1/stores/{$store->id}", [], ['X-Tenant-Id' => $tenant->id])->assertOk();

        $this->assertNull($this->lastActive($tenant));
    }
}
