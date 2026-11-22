<?php

namespace Tests;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Http;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests(); // no real network calls from tests
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

        TenantUser::query()->create(['tenant_id' => $tenant->id, 'user_id' => $user->id, 'role' => $role]);

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
