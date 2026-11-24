<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Marketing\Attribution;
use App\Domain\Marketing\Models\CampaignConversion;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-5 §5.5 attribution (P85-21: 7-day window, latest send wins, cancelled excluded, one row per order) and the
 * marketing overview numbers (P85-22, §6.2, §9.1).
 */
#[Group('campaigns')]
class AttributionOverviewTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    private const SHOPPER = '01711000001'; // checkoutBody() contact phone

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    private function sendCampaign(array $h, Store $store, string $name = 'Eid'): string
    {
        $id = $this->createCampaign($h, $store, ['name' => $name]);
        $this->sendNow($h, $store, $id)->assertStatus(202);

        return $id;
    }

    private function order(Store $store, string $variant, ?string $coupon = null, ?string $phone = null): Order
    {
        $number = $this->placeOrder($store, $variant, 1, $phone !== null ? ['contact' => ['phone' => $phone]] : [], $coupon)->json('data.order.number');

        return $this->inTenant($store->tenant_id, fn () => Order::query()->where('number', $number)->firstOrFail());
    }

    /** @return Collection<int, CampaignConversion> */
    private function conversions(Tenant $tenant): Collection
    {
        return $this->platformQuery(CampaignConversion::class)->where('tenant_id', $tenant->id)->get();
    }

    public function test_an_order_within_seven_days_is_attributed_to_the_latest_send(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $this->customer($h, $store, ['phone' => self::SHOPPER]);
        $first = $this->sendCampaign($h, $store, 'First');
        Carbon::setTestNow(now()->addDay());
        $second = $this->sendCampaign($h, $store, 'Second');
        Carbon::setTestNow(now()->addDays(2));
        $order = $this->order($store, $variant);

        $rows = $this->conversions($tenant);
        $this->assertCount(1, $rows);
        $this->assertSame([$second, $order->id], [$rows[0]->campaign_id, $rows[0]->order_id]);
        $this->assertNotNull($rows[0]->recipient_id);

        // Idempotent: one row per order.
        $this->inTenant($tenant, fn () => app(Attribution::class)->attribute($order->id));
        $this->assertCount(1, $this->conversions($tenant));

        $this->api($h, 'GET', $this->cUrl($store, "/{$second}"))->assertOk()
            ->assertJsonPath('data.stats.orders', 1)->assertJsonPath('data.stats.revenue_amount', $order->total_amount);
        $this->api($h, 'GET', $this->cUrl($store, "/{$first}"))->assertOk()->assertJsonPath('data.stats.orders', 0);
        $this->api($h, 'GET', $this->cUrl($store, "/{$second}/recipients"))->assertOk()
            ->assertJsonPath('data.0.attributed_order', ['id' => $order->id, 'number' => $order->number, 'total_amount' => $order->total_amount]);

        // Cancelled orders don't count (evaluated at read time).
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/cancel", ['reason' => 'other'])->assertOk();
        $this->api($h, 'GET', $this->cUrl($store, "/{$second}"))->assertOk()
            ->assertJsonPath('data.stats.orders', 0)->assertJsonPath('data.stats.revenue_amount', 0);
    }

    public function test_orders_after_seven_days_or_by_other_customers_are_not_attributed(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $this->customer($h, $store, ['phone' => self::SHOPPER]);
        $this->sendCampaign($h, $store);
        Carbon::setTestNow(now()->addDays(7)->addMinute());
        $this->order($store, $variant);
        $this->assertCount(0, $this->conversions($tenant));

        // A customer who wasn't a recipient (no consent, no orders → never messaged).
        [, $tenant2, $store2, $h2] = $this->campaignShop(slug: 'other');
        [, $variant2] = $this->stocked($h2, $store2, 100000, 50);
        $this->customer($h2, $store2, ['phone' => '01811000002']);
        $this->sendCampaign($h2, $store2);
        $this->order($store2, $variant2);
        $this->assertCount(0, $this->conversions($tenant2));
    }

    public function test_marketing_overview_numbers(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'EID20', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active'])->assertCreated()->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'DRAFTY', 'type' => 'fixed', 'amount' => 100])->assertCreated();
        $this->customer($h, $store, ['phone' => self::SHOPPER]);
        $campaign = $this->sendCampaign($h, $store);
        $campaignOrder = $this->order($store, $variant); // campaign conversion
        $couponOrder = $this->order($store, $variant, 'EID20'); // coupon and conversion → counted once, as campaign
        Carbon::setTestNow(now()->addDays(8));
        $late = $this->order($store, $variant, 'EID20', '01811000009'); // coupon only (another shopper)
        $this->order($store, $variant); // neither
        // One unsubscribe by link.
        $code = $this->codeIn($this->sms()->sent[0]['text']);
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk();

        $o = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/marketing/overview?range=30d")->assertOk()->json('data');
        $this->assertSame('30d', $o['range']);
        $this->assertSame($campaignOrder->total_amount + $couponOrder->total_amount + $late->total_amount, $o['kpis']['revenue_amount']);
        $this->assertNull($o['kpis']['revenue_change_pct']);
        $this->assertSame(2, $o['kpis']['campaign_orders']);
        $this->assertEquals(50.0, $o['kpis']['campaign_orders_share_pct']);
        $this->assertSame(1, $o['kpis']['messages_sent']);
        $this->assertSame(1, $o['kpis']['unsubscribes']);
        $this->assertSame(['coupons' => 2, 'campaigns' => 1], $o['counts']);
        $this->assertSame('BDT', $o['currency']);
        $this->assertCount(8, $o['series']);
        $this->assertSame($campaignOrder->total_amount + $couponOrder->total_amount, array_sum(array_column($o['series'], 'campaigns_amount')));
        $this->assertSame($late->total_amount, array_sum(array_column($o['series'], 'coupons_amount')));
        $this->assertSame(Carbon::now('Asia/Dhaka')->startOfWeek()->format('Y-m-d'), $o['series'][7]['week_start']);
        $this->assertSame(1, count($o['active_coupons']));
        $this->assertSame(['id' => $coupon, 'code' => 'EID20', 'type' => 'fixed', 'percent_bps' => null, 'amount' => 10000, 'ends_at' => null, 'used_count' => 2, 'usage_limit' => null, 'revenue_amount' => $couponOrder->total_amount + $late->total_amount], $o['active_coupons'][0]);
        $this->assertSame([$campaign], array_column($o['recent_campaigns'], 'id'));
        $this->assertArrayNotHasKey('body', $o['recent_campaigns'][0]);

        // 7d: only the late orders; the previous 7 days had the campaign revenue → change −x %.
        $week = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/marketing/overview?range=7d")->assertOk()->json('data');
        $this->assertSame($late->total_amount, $week['kpis']['revenue_amount']);
        $prev = $campaignOrder->total_amount + $couponOrder->total_amount;
        $this->assertEquals(round(($late->total_amount - $prev) * 100 / $prev, 1), $week['kpis']['revenue_change_pct']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/marketing/overview?range=1y")->assertStatus(422);
    }
}
