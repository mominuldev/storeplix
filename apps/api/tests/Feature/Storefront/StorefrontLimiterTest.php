<?php

namespace Tests\Feature\Storefront;

use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * S37 / P5B-9 (PHASE-5B-CONTRACT §2.10): `throttle:storefront` = per store host + trusted shopper IP (IPv6 by /64)
 * AND per store host. The limits are lowered through config (THROTTLE_STOREFRONT_PER_IP / _PER_HOST) to keep the
 * test fast; the defaults are asserted separately.
 */
#[Group('security')]
class StorefrontLimiterTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    private Store $store;

    protected function setUp(): void
    {
        parent::setUp();
        [, , $this->store] = $this->liveShop('limits');
        config(['storeplix.storefront_per_ip_per_minute' => 5, 'storeplix.storefront_per_host_per_minute' => 12]);
    }

    public function test_defaults_are_300_per_shopper_ip_and_3000_per_host(): void
    {
        $defaults = require base_path('config/storeplix.php');
        $this->assertSame(300, $defaults['storefront_per_ip_per_minute']);
        $this->assertSame(3000, $defaults['storefront_per_host_per_minute']);
    }

    public function test_one_shopper_ip_is_limited_while_another_ip_on_the_same_store_is_served(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->hit('203.0.113.10')->assertOk();
        }
        $this->hit('203.0.113.10')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->hit('203.0.113.11')->assertOk();
    }

    public function test_the_host_limit_applies_across_ips(): void
    {
        for ($i = 0; $i < 12; $i++) {
            $this->hit('198.51.100.'.($i + 1))->assertOk();
        }
        $this->hit('198.51.100.200')->assertStatus(429);
    }

    public function test_without_the_header_only_the_host_limit_applies(): void
    {
        for ($i = 0; $i < 12; $i++) {
            $this->hit(null)->assertOk(); // > the per-IP limit: no shared "server IP" bucket
        }
        $this->hit(null)->assertStatus(429);
    }

    public function test_a_spoofed_client_ip_without_a_valid_key_is_ignored(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->hit('203.0.113.50', key: 'wrong-key')->assertStatus(401); // counted per request IP only
        }
        $this->hit('203.0.113.50')->assertOk(); // the real shopper's bucket was never touched
    }

    /** QA 5b-1 F-M1: keyless / wrong-key requests never drain the shop's host bucket. */
    public function test_requests_without_a_valid_key_do_not_count_against_the_host(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->hit('198.51.100.'.($i + 1), key: 'wrong-key')->assertStatus(401);
        }
        $this->hit('198.51.100.9', key: 'wrong-key')->assertStatus(429); // their own per-IP bucket is full
        for ($i = 0; $i < 12; $i++) {
            $this->hit('192.0.2.'.($i + 1))->assertOk(); // the full host budget is still there
        }
        $this->hit('192.0.2.200')->assertStatus(429);
    }

    /** QA 5b-1 F-L5: a keyed request without the shopper IP logs one warning per host per 5 minutes. */
    public function test_a_missing_client_ip_is_logged_once_per_host(): void
    {
        Log::spy();
        $this->hit(null)->assertOk();
        $this->hit(null)->assertOk();
        Log::shouldHaveReceived('warning')->with('storefront.client_ip_missing', \Mockery::any())->once();
    }

    public function test_ipv6_addresses_in_one_64_share_a_bucket(): void
    {
        for ($i = 1; $i <= 5; $i++) {
            $this->hit("2001:db8:aa:bb::{$i}")->assertOk();
        }
        $this->hit('2001:db8:aa:bb:ffff::1')->assertStatus(429);
        $this->hit('2001:db8:aa:bc::1')->assertOk();
    }

    private function hit(?string $ip, ?string $key = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders(array_filter([
            'X-Storefront-Key' => $key ?? (string) config('storeplix.storefront_api_key'),
            'X-Storefront-Host' => $this->host($this->store),
            'X-Storefront-Client-Ip' => $ip,
        ], fn ($v) => $v !== null))->getJson('/api/v1/storefront/config');
    }
}
