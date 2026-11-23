<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Impersonation;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\RlsFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * S72 / S77 under forced RLS (PHASE-8-1 §5.2): an impersonated request runs on the app role with app.tenant_id = the
 * target and app.user_id = the staff user; it sees exactly the target's rows. Postgres + RLS only.
 */
#[Group('impersonation')]
#[Group('rls')]
#[Group('security')]
class ImpersonationRlsTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, RlsFixtures, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
        $this->useSpaBrowser();
        Mail::fake();
    }

    public function test_impersonation_reads_only_the_target_tenant_with_rls_on(): void
    {
        [$ownerA, $a, $storeA, $ha] = $this->shop('owner', 'ashop');
        [, $b, $storeB, $hb] = $this->shop('owner', 'bshop');
        $productA = $this->createProduct($ha, $storeA, $this->simpleProduct('A Panjabi'))['id'];
        $this->createProduct($hb, $storeB, $this->simpleProduct('B Saree'));

        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [$row, $url] = app(ImpersonationService::class)->create($staff, $a, 'Customer ticket: orders not showing', null, null, null);

        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk()
            ->assertJsonPath('data.impersonation.owner_name', $ownerA->name);

        $h = ['X-Tenant-Id' => $a->id];
        $this->browser('GET', "/api/v1/stores/{$storeA->id}/products", headers: $h)->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $productA);
        $this->browser('GET', "/api/v1/stores/{$storeB->id}/products", headers: $h)->assertNotFound();
        $this->browser('GET', "/api/v1/stores/{$storeB->id}/products", headers: ['X-Tenant-Id' => $b->id])->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');
        $this->browser('POST', "/api/v1/stores/{$storeA->id}/products", $this->simpleProduct('Nope'), $h)->assertForbidden()
            ->assertJsonPath('error.code', 'impersonation_read_only');

        $this->assertSame(2, PlatformImpersonation::query()->findOrFail($row->id)->request_count);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $a->id)->where('action', 'admin.impersonation_started')->count());

        $this->browser('DELETE', '/api/v1/auth/impersonation')->assertNoContent();
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $a->id)->where('action', 'admin.impersonation_ended')->count());

        // The close command runs on the console path (no request, no tenant) and still audits on the tenant.
        [$late] = app(ImpersonationService::class)->create($staff, $b, 'Customer ticket: orders not showing', null, null, null);
        PlatformImpersonation::query()->whereKey($late->id)->update(['status' => 'active', 'started_at' => now()->subMinutes(20), 'expires_at' => now()->subMinutes(5)]);
        $this->artisan('admin:close-impersonations')->assertSuccessful();
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $b->id)->where('action', 'admin.impersonation_ended')->count());
    }
}
