<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Permissions;

use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/**
 * PHASE-8-1 §2.1, §10 `AdminPermissionTest`; S67, S68, S75. Driven by the LIVE route list: every authenticated
 * `api/v1/admin/*` route (any owner) is covered automatically. Guest sign-in / invitation routes (no `auth:sanctum`)
 * are excluded. For each route: guest → 401; merchant-surface and impersonation-surface sessions (also of a user with
 * a platform role) → 403; disabled or locked staff → 403; every role without the route's `platform.can` permission
 * → 403 `forbidden`. Roles that have the permission are not called here (each feature test covers its happy path).
 */
#[Group('admin')]
#[Group('security')]
class AdminPermissionTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase;

    private const BASE_STACK = ['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'];

    /** Authenticated routes that need no `platform.can` (the session itself). */
    private const NO_PERMISSION = ['api/v1/admin/auth/me', 'api/v1/admin/auth/logout'];

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.ip_allowlist' => [], 'admin.email_domains' => []]);
    }

    /** @return list<array{route: Route, method: string, uri: string, permission: PlatformPermission|null}> */
    private function adminRoutes(): array
    {
        $rows = [];
        foreach (Router::getRoutes()->getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/v1/admin/') || ! in_array('auth:sanctum', $route->gatherMiddleware(), true)) {
                continue;
            }
            $permission = null;
            foreach ($route->gatherMiddleware() as $middleware) {
                if (is_string($middleware) && str_starts_with($middleware, 'platform.can:')) {
                    $permission = PlatformPermission::from(substr($middleware, strlen('platform.can:')));
                }
            }
            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $uri = '/'.preg_replace_callback('/\{[^}]+\}/', fn () => strtolower((string) Str::ulid()), $route->uri());
                $rows[] = ['route' => $route, 'method' => $method, 'uri' => $uri, 'permission' => $permission];
            }
        }

        return $rows;
    }

    /** @param array<string, string> $headers */
    private function hit(string $method, string $uri, array $headers): TestResponse
    {
        return $this->flushHeaders()->withHeaders($headers)->json($method, $uri, ['reason' => 'Permission matrix check']);
    }

    private function label(array $row, string $case): string
    {
        return "{$row['method']} {$row['uri']} ({$case})";
    }

    public function test_every_authenticated_admin_route_has_the_admin_stack(): void
    {
        $routes = $this->adminRoutes();
        $uris = array_map(fn (array $r) => $r['route']->uri(), $routes);
        $this->assertContains('api/v1/admin/team', $uris);
        $this->assertContains('api/v1/admin/auth/me', $uris);

        foreach ($routes as $row) {
            $middleware = $row['route']->gatherMiddleware();
            foreach (self::BASE_STACK as $required) {
                $this->assertContains($required, $middleware, $this->label($row, "missing {$required}"));
            }
            if (! in_array($row['route']->uri(), self::NO_PERMISSION, true)) {
                $this->assertNotNull($row['permission'], $this->label($row, 'missing platform.can'));
                if ($row['method'] !== 'GET') {
                    $this->assertContains('throttle:admin-write', $middleware, $this->label($row, 'write without throttle:admin-write'));
                }
            }
        }
    }

    public function test_guests_get_401_on_every_admin_route(): void
    {
        foreach ($this->adminRoutes() as $row) {
            $response = $this->hit($row['method'], $row['uri'], ['Referer' => self::ADMIN_ORIGIN.'/']);
            $this->assertSame(401, $response->status(), $this->label($row, 'guest').': '.$response->getContent());
        }
    }

    /** S67: a merchant session never works on /admin/*, even for a user who has a platform role. */
    public function test_merchant_and_impersonation_sessions_get_403_on_every_admin_route(): void
    {
        foreach ($this->adminRoutes() as $row) {
            foreach ([
                'merchant' => [User::factory()->create(), SessionSurface::MERCHANT],
                'merchant session of a super admin' => [$this->staffUser(PlatformRole::SuperAdmin), SessionSurface::MERCHANT],
                'impersonation session' => [$this->staffUser(PlatformRole::SuperAdmin), SessionSurface::IMPERSONATION],
            ] as $case => [$user, $surface]) {
                $this->asAdminSurface($surface);
                $response = $this->hit($row['method'], $row['uri'], $this->adminHeaders($user));
                $this->assertSame(403, $response->status(), $this->label($row, $case).': '.$response->getContent());
                $this->assertSame('forbidden', $response->json('error.code'), $this->label($row, $case));
            }
        }
    }

    /** Disabled and locked staff, and users who lost their role, are refused on an otherwise valid admin session. */
    public function test_inactive_staff_get_403_on_every_admin_route(): void
    {
        foreach ($this->adminRoutes() as $row) {
            foreach ([
                'disabled' => $this->staffUser(PlatformRole::SuperAdmin, ['platform_disabled_at' => now()]),
                'locked' => $this->staffUser(PlatformRole::SuperAdmin, ['platform_locked_until' => now()->addMinutes(10)]),
                'role revoked' => $this->staffUser(PlatformRole::SuperAdmin, ['platform_role' => null]),
            ] as $case => $user) {
                $this->asAdminSurface();
                $response = $this->hit($row['method'], $row['uri'], $this->adminHeaders($user));
                $this->assertSame(403, $response->status(), $this->label($row, $case).': '.$response->getContent());
            }
        }
    }

    /** S75: every role without the route's permission → 403 `forbidden` (the §2.1 matrix, one cell per assertion). */
    public function test_roles_without_the_route_permission_get_403(): void
    {
        $checked = 0;
        foreach ($this->adminRoutes() as $row) {
            if ($row['permission'] === null) {
                continue;
            }
            foreach (PlatformRole::cases() as $role) {
                if ($role->can($row['permission'])) {
                    continue;
                }
                $this->asAdminSurface();
                $response = $this->hit($row['method'], $row['uri'], $this->adminHeaders($this->staffUser($role)));
                $this->assertSame(403, $response->status(), $this->label($row, $role->value).': '.$response->getContent());
                $this->assertSame('forbidden', $response->json('error.code'));
                $checked++;
            }
        }
        $this->assertGreaterThan(0, $checked);
    }

    /** The §2.1 matrix itself (single source: PlatformRole::permissions()). */
    public function test_permission_matrix_matches_the_contract(): void
    {
        $expected = [
            'super_admin' => ['view_merchants', 'impersonate', 'manage_billing', 'manage_domains', 'suspend', 'manage_team'],
            'billing' => ['view_merchants', 'manage_billing'],
            'support' => ['view_merchants', 'impersonate', 'manage_domains'],
            'read_only' => ['view_merchants'],
        ];
        foreach (PlatformRole::cases() as $role) {
            $this->assertSame($expected[$role->value], array_map(fn (PlatformPermission $p) => $p->value, $role->permissions()), $role->value);
        }
    }

    /** S68: an admin-surface session is refused on merchant routes, even for the staff member's own shop. */
    public function test_admin_session_gets_403_on_merchant_routes(): void
    {
        $staff = $this->staffUser(PlatformRole::SuperAdmin);
        [, $tenant] = $this->merchant(TenantUser::ROLE_OWNER);
        $this->inTenant($tenant, fn () => TenantUser::query()->where('tenant_id', $tenant->id)->update(['user_id' => $staff->id]));
        $store = $this->storeFor($tenant, 'staffshop');
        $headers = $this->adminHeaders($staff) + ['X-Tenant-Id' => $tenant->id];

        $this->flushHeaders()->withHeaders($headers)->getJson('/api/v1/stores')->assertOk(); // merchant surface works

        foreach (['GET /api/v1/stores', 'GET /api/v1/stores/'.$store->id, 'GET /api/v1/audit-logs', 'GET /api/v1/subscription', 'POST /api/v1/stores/'.$store->id.'/products'] as $call) {
            [$method, $uri] = explode(' ', $call);
            $this->asAdminSurface();
            $this->flushHeaders()->withHeaders($headers)->json($method, $uri)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        $this->assertSame(1, $this->inTenant($tenant, fn () => Store::query()->count()));
    }
}
