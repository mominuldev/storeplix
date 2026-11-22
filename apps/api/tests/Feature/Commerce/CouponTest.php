<?php

namespace Tests\Feature\Commerce;

use App\Domain\Coupons\Models\Coupon;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Carbon;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.6 coupons (P5-11..P5-13) and §12 "Coupons". */
class CouponTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_crud_type_rules_and_uniqueness(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $url = "/api/v1/stores/{$store->id}/coupons";
        $c = $this->api($h, 'POST', $url, ['code' => ' winter15 ', 'type' => 'percentage', 'percent_bps' => 1500, 'max_discount_amount' => 20000])->assertCreated()
            ->assertJsonPath('data.code', 'WINTER15')->assertJsonPath('data.status', 'draft')->assertJsonPath('data.display_status', 'draft')
            ->assertJsonPath('data.usage_per_customer', 1)->assertJsonPath('data.share_path', '/discount/WINTER15')
            ->assertJsonPath('data.stats', ['used_count' => 0, 'orders_count' => 0, 'revenue_amount' => 0, 'discount_amount' => 0])->json('data');
        $this->api($h, 'POST', $url, ['code' => 'Winter15', 'type' => 'fixed', 'amount' => 100])->assertStatus(422)->assertJsonPath('error.details.code.0', 'This code is already used.');
        $this->api($h, 'POST', $url, ['code' => 'x!', 'type' => 'fixed', 'amount' => 100])->assertStatus(422);
        $this->api($h, 'POST', $url, ['code' => 'PCT', 'type' => 'percentage'])->assertStatus(422)->assertJsonValidationErrors(['percent_bps'], 'error.details');
        $this->api($h, 'POST', $url, ['code' => 'PCT', 'type' => 'percentage', 'percent_bps' => 10001])->assertStatus(422);
        $this->api($h, 'POST', $url, ['code' => 'FIX', 'type' => 'fixed', 'amount' => 100, 'max_discount_amount' => 5])->assertStatus(422);
        $this->api($h, 'POST', $url, ['code' => 'FIX', 'type' => 'fixed', 'amount' => 10.5])->assertStatus(422);
        $this->api($h, 'POST', $url, ['code' => 'SHIP', 'type' => 'free_shipping', 'applies_to' => 'products', 'product_ids' => []])->assertStatus(422);
        $this->api($h, 'POST', $url, ['code' => 'CAT', 'type' => 'fixed', 'amount' => 100, 'applies_to' => 'categories', 'category_ids' => ['01jzzzzzzzzzzzzzzzzzzzzzzz']])->assertStatus(422)
            ->assertJsonPath('error.details', ['category_ids.0' => ['Unknown category.']]);
        $this->api($h, 'POST', $url, ['code' => 'DATES', 'type' => 'fixed', 'amount' => 100, 'starts_at' => '2026-12-01T00:00:00Z', 'ends_at' => '2026-11-01T00:00:00Z'])->assertStatus(422);

        $this->api($h, 'PATCH', "{$url}/{$c['id']}", ['revision' => 9, 'status' => 'active'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', "{$url}/{$c['id']}", ['revision' => 1, 'status' => 'active', 'type' => 'fixed', 'amount' => 30000])->assertOk()
            ->assertJsonPath('data.type', 'fixed')->assertJsonPath('data.percent_bps', null)->assertJsonPath('data.max_discount_amount', null)
            ->assertJsonPath('data.revision', 2)->assertJsonPath('data.display_status', 'active');
        $this->api($h, 'GET', "{$url}/{$c['id']}")->assertOk()->assertJsonPath('data.amount', 30000);
        $this->api($h, 'DELETE', "{$url}/{$c['id']}")->assertNoContent();
        $this->assertSame(0, Coupon::withoutTenancy()->count());
    }

    public function test_derived_statuses_list_filters_counts_and_sorts(): void
    {
        Carbon::setTestNow('2026-11-22 10:00:00');
        [, , $store, $h] = $this->liveShop();
        $url = "/api/v1/stores/{$store->id}/coupons";
        $make = fn (string $code, array $extra) => $this->api($h, 'POST', $url, $extra + ['code' => $code, 'type' => 'fixed', 'amount' => 100, 'status' => 'active'])->assertCreated();
        $make('LIVE', []);
        $make('SOON', ['starts_at' => '2026-12-01T00:00:00+06:00']);
        $make('OLD', ['starts_at' => '2026-10-01T00:00:00+06:00', 'ends_at' => '2026-11-01T00:00:00+06:00']);
        $make('DRAFTY', ['status' => 'draft']);
        $make('OFF', ['status' => 'disabled']);

        $res = $this->api($h, 'GET', $url)->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 5, 'active' => 1, 'scheduled' => 1, 'expired' => 1])
            ->assertJsonPath('meta.total', 5);
        $this->assertEqualsCanonicalizing(['OFF', 'DRAFTY', 'OLD', 'SOON', 'LIVE'], array_column($res->json('data'), 'code'));
        $statuses = array_column($res->json('data'), 'display_status', 'code');
        $this->assertSame(['OFF' => 'disabled', 'DRAFTY' => 'draft', 'OLD' => 'expired', 'SOON' => 'scheduled', 'LIVE' => 'active'], $statuses);
        $this->assertEqualsCanonicalizing(['SOON', 'OLD'], array_column($this->api($h, 'GET', "{$url}?filter[status]=scheduled,expired")->json('data'), 'code'));
        $this->assertSame(['LIVE'], array_column($this->api($h, 'GET', "{$url}?q=liv")->json('data'), 'code'));
        $this->api($h, 'GET', "{$url}?filter[status]=bogus")->assertStatus(422);
        $this->api($h, 'GET', "{$url}?sort=-revenue")->assertOk();
    }

    public function test_usage_limits_per_customer_first_order_and_dates_in_checkout(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $url = "/api/v1/stores/{$store->id}/coupons";
        $this->api($h, 'POST', $url, ['code' => 'ONCE', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active', 'usage_limit' => 2])->assertCreated();
        $this->api($h, 'POST', $url, ['code' => 'FIRST', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active', 'first_order_only' => true, 'usage_per_customer' => null])->assertCreated();

        $this->placeOrder($store, $variant, 1, ['contact' => ['phone' => '01711000001']], 'ONCE')->assertJsonPath('data.order.discount_amount', 10000);
        // same phone again: per-customer rule is only checked at checkout
        $cart = $this->cartWith($store, $variant);
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'ONCE'], $cart)->assertOk();
        $this->checkout($store, $cart, $this->checkoutBody(97000))->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid')
            ->assertJsonPath('error.details.code.0', "You've already used this code.");
        $this->placeOrder($store, $variant, 1, ['contact' => ['phone' => '01711000002']], 'ONCE');
        $cart = $this->cartWith($store, $variant);
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'ONCE'], $cart)->assertStatus(422)->assertJsonPath('error.details.code.0', 'This code has been fully used.');
        $this->api($h, 'GET', $url.'?filter[status]=used_up')->assertJsonPath('data.0.code', 'ONCE')
            ->assertJsonPath('data.0.stats.used_count', 2)->assertJsonPath('data.0.stats.orders_count', 2)
            ->assertJsonPath('data.0.stats.revenue_amount', 194000)->assertJsonPath('data.0.stats.discount_amount', 20000);

        // first order only: phone 01711000001 already ordered
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'FIRST'], $cart)->assertOk();
        $this->checkout($store, $cart, $this->checkoutBody(97000, ['contact' => ['phone' => '01711000001']]))->assertStatus(422)
            ->assertJsonPath('error.details.code.0', 'This code is for first orders only.');
        $this->checkout($store, $cart, $this->checkoutBody(97000, ['contact' => ['phone' => '01911000003']]))->assertCreated();

        // code and type are immutable once used; a used coupon can't be deleted
        $once = $this->api($h, 'GET', $url.'?q=ONCE')->json('data.0');
        $this->api($h, 'PATCH', "{$url}/{$once['id']}", ['revision' => $once['revision'], 'code' => 'TWICE'])->assertStatus(422)
            ->assertJsonPath('error.details.code.0', 'Create a new code instead.');
        $this->api($h, 'PATCH', "{$url}/{$once['id']}", ['revision' => $once['revision'], 'status' => 'disabled'])->assertOk();
        $this->api($h, 'DELETE', "{$url}/{$once['id']}")->assertStatus(409)->assertJsonPath('error.code', 'coupon_in_use');
    }

    public function test_dates_are_enforced_and_cancel_releases_the_redemption(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $url = "/api/v1/stores/{$store->id}/coupons";
        $this->api($h, 'POST', $url, ['code' => 'LATER', 'type' => 'fixed', 'amount' => 100, 'status' => 'active', 'starts_at' => now()->addDay()->toIso8601String()])->assertCreated();
        $this->api($h, 'POST', $url, ['code' => 'GONE', 'type' => 'fixed', 'amount' => 100, 'status' => 'active', 'starts_at' => now()->subDays(2)->toIso8601String(), 'ends_at' => now()->subMinute()->toIso8601String()])->assertCreated();
        $this->api($h, 'POST', $url, ['code' => 'ONE', 'type' => 'fixed', 'amount' => 100, 'status' => 'active', 'usage_limit' => 1])->assertCreated();
        $cart = $this->cartWith($store, $variant);
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'LATER'], $cart)->assertStatus(422)->assertJsonPath('error.details.code.0', "This code isn't active yet.");
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'GONE'], $cart)->assertStatus(422)->assertJsonPath('error.details.code.0', 'This code has expired.');

        $order = $this->placeOrder($store, $variant, 1, [], 'ONE')->json('data.order.number');
        $id = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?q={$order}")->json('data.0.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/cancel", ['reason' => 'duplicate'])->assertOk();
        $this->tenancy()->run($tenant, fn () => $this->assertSame(0, Coupon::query()->where('code', 'ONE')->value('used_count')));
        $this->placeOrder($store, $variant, 1, ['contact' => ['phone' => '01711000004']], 'ONE')->assertJsonPath('data.order.coupon_code', 'ONE');
    }

    public function test_staff_reads_but_cannot_write_coupons(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $url = "/api/v1/stores/{$store->id}/coupons";
        $c = $this->api($h, 'POST', $url, ['code' => 'STAFFX', 'type' => 'fixed', 'amount' => 100])->json('data');
        $this->api($staff, 'GET', $url)->assertOk();
        $this->api($staff, 'GET', "{$url}/{$c['id']}")->assertOk();
        $this->api($staff, 'POST', $url, ['code' => 'NOPE', 'type' => 'fixed', 'amount' => 100])->assertForbidden();
        $this->api($staff, 'PATCH', "{$url}/{$c['id']}", ['revision' => 1, 'status' => 'active'])->assertForbidden();
        $this->api($staff, 'DELETE', "{$url}/{$c['id']}")->assertForbidden();
    }
}
