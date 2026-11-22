<?php

declare(strict_types=1);

namespace Tests\Feature\Stores;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * Inline `throttle:N,1` limits key on the user id only, so without a prefix every inline-throttled route shared one
 * bucket per user (e.g. ~20 courier area lookups blocked bulk booking for a minute). Each route now passes its own
 * prefix (`throttle:N,1,{route name}`): using up one route's limit must not touch another's.
 */
#[Group('security')]
class InlineThrottleTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_inline_limits_are_counted_per_route(): void
    {
        Cache::flush();
        [, , $store, $h] = $this->liveShop('thr');

        // stores.preview-token: 30/min. Use it up.
        for ($i = 0; $i < 30; $i++) {
            $this->assertNotSame(429, $this->api($h, 'POST', "/api/v1/stores/{$store->id}/preview-token")->status(), "call {$i}");
        }
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/preview-token")->assertStatus(429);

        // A different inline-throttled route (stores.documents.preview, also 30/min) still has its own budget.
        $this->assertNotSame(429, $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents/preview", ['kind' => 'label_4x6'])->status());
    }
}
