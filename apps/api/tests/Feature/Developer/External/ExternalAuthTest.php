<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\External;

use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Developer\External\Http\Middleware\AuthenticateApiKey;
use App\Domain\Developer\External\Http\Middleware\RequireApiScope;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Routing\Route;
use Illuminate\Routing\Router;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Developer\ApiKeys\ApiKeyFixtures;
use Tests\TestCase;

/** PHASE-8-4 §3 authentication of the external API: S101, S103, S104, S106, S111, /me, last_used_at, middleware order. */
#[Group('developer-api')]
#[Group('security')]
class ExternalAuthTest extends TestCase
{
    use ApiKeyFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    public function test_me_returns_the_key_identity_and_store(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [$id, $plain] = $this->createKey($h, ['products:write']);

        $res = $this->ext($plain, 'GET', '/me')->assertOk();
        $this->assertSame([
            'id' => $id, 'name' => 'Zapier', 'scopes' => ['products:read', 'products:write'], 'tenant_id' => $tenant->id,
            'store' => ['id' => $store->id, 'name' => $store->name, 'currency' => 'BDT'],
        ], $res->json('data'));
        $res->assertHeader('X-RateLimit-Limit', '120')->assertHeader('RateLimit-Limit', '120');
    }

    public function test_malformed_unknown_and_revoked_keys_get_the_identical_401(): void
    {
        [, , , $h] = $this->devShop();
        [$id, $plain] = $this->createKey($h, ['orders:read']);
        $this->api($h, 'DELETE', "/api/v1/api-keys/{$id}")->assertOk();

        $bodies = [];
        foreach ([null, 'nope', 'sp_live_short', 'sp_test_'.str_repeat('a', 40), 'sp_live_'.str_repeat('a', 40), $plain, $plain.' '] as $candidate) {
            $res = $this->ext($candidate, 'GET', '/me')->assertUnauthorized();
            $bodies[] = $res->getContent();
        }
        $this->assertCount(1, array_unique($bodies));
        $this->assertSame('invalid_api_key', json_decode($bodies[0], true)['error']['code']);
        // Basic or other schemes are not accepted
        $this->flushHeaders()->withHeaders(['Authorization' => 'Basic '.base64_encode($plain.':'), 'Origin' => 'https://x.test'])
            ->getJson('/api/v1/external/me')->assertUnauthorized();
    }

    public function test_a_session_never_authenticates_the_external_api_and_a_key_never_the_merchant_api(): void
    {
        [, , $store, $h] = $this->devShop();
        [, $plain] = $this->fullKey($h);

        // S104: signed-in member (session) without a key → 401; X-Tenant-Id is ignored.
        $this->api($h, 'GET', '/api/v1/external/me')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_api_key');
        $this->api($h, 'GET', "/api/v1/external/stores/{$store->id}/orders")->assertUnauthorized();

        // A key on merchant routes → 401 (Bearer is never read there).
        foreach (['/api/v1/auth/me', "/api/v1/stores/{$store->id}/orders", '/api/v1/api-keys'] as $url) {
            $this->flushHeaders()->withHeaders(['Authorization' => 'Bearer '.$plain, 'Origin' => 'https://x.test'])
                ->getJson($url)->assertUnauthorized();
        }
    }

    public function test_suspended_tenant_403_and_plan_without_api_webhooks_402(): void
    {
        [, $tenant, , $h] = $this->devShop();
        [, $plain] = $this->fullKey($h);

        $this->planFor($tenant, Plan::STARTER);
        $this->ext($plain, 'GET', '/me')->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')
            ->assertJsonPath('error.details.upgrade_plan', ['growth']);
        $this->planFor($tenant, Plan::GROWTH);

        $this->platformQuery(Tenant::class)->whereKey($tenant->id)->update(['status' => Tenant::STATUS_SUSPENDED]);
        $this->ext($plain, 'GET', '/me')->assertForbidden()->assertJsonPath('error.code', 'tenant_suspended');
    }

    public function test_scope_is_enforced_with_api_key_scope_missing(): void
    {
        [, , $store, $h] = $this->devShop();
        [, $plain] = $this->createKey($h, ['customers:read']);

        $this->ext($plain, 'GET', "/stores/{$store->id}/orders")->assertForbidden()
            ->assertJsonPath('error.code', 'api_key_scope_missing')->assertJsonPath('error.details.required_scope', ['orders:read']);
        $this->ext($plain, 'GET', "/stores/{$store->id}/customers")->assertOk();
    }

    public function test_every_external_route_declares_exactly_one_known_scope_and_no_session_auth(): void
    {
        $count = 0;
        /** @var Route $route */
        foreach (app(Router::class)->getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/v1/external')) {
                continue;
            }
            $count++;
            $mw = $route->gatherMiddleware();
            $scopes = array_values(array_filter($mw, fn ($m) => is_string($m) && str_starts_with($m, 'scope:')));
            $this->assertCount(1, $scopes, $route->uri());
            $spec = substr($scopes[0], 6);
            $this->assertTrue($spec === RequireApiScope::ANY ? $route->uri() === 'api/v1/external/me' : ApiScope::tryFrom($spec) !== null, $route->uri());
            $this->assertContains('apikey', $mw);
            $this->assertContains('throttle:external-api', $mw);
            $this->assertNotContains('auth:sanctum', $mw);
            $this->assertNotContains('tenant', $mw);
            if (in_array('POST', $route->methods(), true) && str_contains($route->uri(), '/status') || str_ends_with($route->uri(), '/adjustments')) {
                $this->assertNotEmpty(array_filter($mw, fn ($m) => is_string($m) && str_starts_with($m, 'idempotent:')), $route->uri());
            }
        }
        $this->assertSame(13, $count);

        $priority = app(Router::class)->middlewarePriority;
        $key = array_search(AuthenticateApiKey::class, $priority, true);
        $this->assertLessThan(array_search(ThrottleRequests::class, $priority, true), $key);
        $this->assertLessThan(array_search(SubstituteBindings::class, $priority, true), $key);
        $this->assertGreaterThan(array_search(SubstituteBindings::class, $priority, true), array_search(RequireApiScope::class, $priority, true));
    }

    public function test_rate_limit_is_120_per_minute_per_key(): void
    {
        [, , , $h] = $this->devShop();
        [, $a] = $this->createKey($h, ['orders:read'], 'A');
        [, $b] = $this->createKey($h, ['orders:read'], 'B');

        for ($i = 0; $i < 120; $i++) {
            $this->ext($a, 'GET', '/me')->assertOk();
        }
        $this->ext($a, 'GET', '/me')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
        $this->ext($b, 'GET', '/me')->assertOk(); // separate bucket
    }

    public function test_last_used_at_is_written_at_most_once_a_minute_without_bumping_updated_at(): void
    {
        [, , , $h] = $this->devShop();
        [$id, $plain] = $this->createKey($h, ['orders:read']);
        $row = fn () => $this->platformQuery(ApiKey::class)->findOrFail($id);
        $updatedAt = $row()->updated_at;

        Carbon::setTestNow(now()->addMinutes(5));
        $this->ext($plain, 'GET', '/me')->assertOk();
        $first = $row()->last_used_at;
        $this->assertNotNull($first);
        $this->assertEquals($updatedAt, $row()->updated_at);

        Carbon::setTestNow(now()->addSeconds(20));
        $this->ext($plain, 'GET', '/me')->assertOk();
        $this->assertEquals($first, $row()->last_used_at);
        $this->assertNotNull($this->api($h, 'GET', '/api/v1/api-keys')->json('data.0.last_used_at'));
        Carbon::setTestNow();
    }
}
