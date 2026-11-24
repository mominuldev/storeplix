<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Customers\CustomerRisk;
use App\Domain\FraudGuard\RiskTier;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-5 §3.2 / §3.3: one test per segment, the exclusions, the P85-3 eligibility matrix, the P85-25 risk classes
 * and the preview breakdown (disjoint buckets; recipients = matched − Σ excluded).
 */
#[Group('campaigns')]
class AudienceTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    /** @param array<string, mixed> $audience @return array<string, mixed> */
    private function preview(array $h, Store $store, array $audience, string $channel = 'sms'): array
    {
        return $this->api($h, 'POST', $this->cUrl($store, '/audience-preview'), [
            'channel' => $channel, 'audience' => $audience + ['exclude' => ['risky' => false, 'ordered_within_days' => null]],
        ])->assertOk()->json('data');
    }

    public function test_segment_all(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $this->customer($h, $store, [], ['orders_count' => 2]);
        $p = $this->preview($h, $store, ['segment' => 'all', 'params' => []]);
        $this->assertSame([2, 2], [$p['matched'], $p['recipients']]);
    }

    public function test_segment_repeat_inactive(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, [], ['orders_count' => 3, 'last_order_at' => now()->subDays(61)]); // in
        $this->customer($h, $store, [], ['orders_count' => 3, 'last_order_at' => now()->subDays(59)]); // active
        $this->customer($h, $store, [], ['orders_count' => 1, 'last_order_at' => now()->subDays(90)]); // one order
        $this->customer($h, $store, [], ['orders_count' => 2, 'last_order_at' => null]);
        $this->assertSame(1, $this->preview($h, $store, ['segment' => 'repeat_inactive', 'params' => []])['recipients']);
        $this->assertSame(2, $this->preview($h, $store, ['segment' => 'repeat_inactive', 'params' => ['min_orders' => 2, 'inactive_days' => 30]])['recipients']);
    }

    public function test_segment_vip(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, [], ['orders_count' => 5, 'total_spent_amount' => 2_000_000]);
        $this->customer($h, $store, [], ['orders_count' => 5, 'total_spent_amount' => 1_999_999]);
        $p = $this->preview($h, $store, ['segment' => 'vip', 'params' => []]);
        $this->assertSame(1, $p['recipients']);
        $this->assertSame(2, $this->preview($h, $store, ['segment' => 'vip', 'params' => ['min_spent_amount' => 100]])['recipients']);
        $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody(['audience' => ['segment' => 'vip', 'params' => []]]))->assertCreated()
            ->assertJsonPath('data.audience_label', 'VIP · spent over ৳ 20,000');
    }

    public function test_segment_new_customers(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, [], ['orders_count' => 1]);
        $this->customer($h, $store, [], ['orders_count' => 1, 'created_at' => now()->subDays(31)]);
        $this->customer($h, $store); // no order yet
        $this->assertSame(1, $this->preview($h, $store, ['segment' => 'new_customers', 'params' => []])['matched']);
        $this->assertSame(2, $this->preview($h, $store, ['segment' => 'new_customers', 'params' => ['days' => 60]])['matched']);
    }

    public function test_segment_one_time(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, [], ['orders_count' => 1]);
        $this->customer($h, $store, [], ['orders_count' => 2]);
        $this->customer($h, $store);
        $this->assertSame(1, $this->preview($h, $store, ['segment' => 'one_time', 'params' => []])['matched']);
    }

    public function test_segment_district(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, ['district' => 'Dhaka']);
        $this->customer($h, $store, ['district' => 'Chattogram']);
        $this->customer($h, $store, ['district' => 'Sylhet']);
        $this->assertSame(2, $this->preview($h, $store, ['segment' => 'district', 'params' => ['districts' => ['dhaka', 'Chattogram']]])['matched']);
    }

    public function test_segment_tag(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, ['tags' => ['vip', 'eid']]);
        $this->customer($h, $store, ['tags' => ['wholesale']]);
        $this->assertSame(1, $this->preview($h, $store, ['segment' => 'tag', 'params' => ['tag' => 'EID']])['matched']);
    }

    public function test_exclusions_and_breakdown(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store); // good
        // PHASE-8-8 P88-4 (§6.6): 6 delivered / 3 returned = 67 % → careful (3/1 = 75 % is now good).
        $this->customer($h, $store, [], ['orders_count' => 9, 'delivered_orders_count' => 6, 'returned_orders_count' => 3]); // careful
        $this->customer($h, $store, [], ['orders_count' => 4, 'delivered_orders_count' => 2, 'returned_orders_count' => 2]); // risky
        $this->customer($h, $store, [], ['orders_count' => 1, 'last_order_at' => now()->subDays(3)]); // recent
        $this->customer($h, $store, ['accepts_marketing' => false]); // not eligible
        $this->customer($h, $store, ['phone' => null, 'email' => 'x@example.com']); // no SMS address
        $optedOut = $this->customer($h, $store);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$optedOut->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();

        $p = $this->preview($h, $store, ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => true, 'ordered_within_days' => 7]]);
        $this->assertSame(7, $p['matched']);
        $this->assertSame(['risky' => 1, 'recent_orders' => 1, 'opted_out' => 1, 'no_address' => 1, 'not_eligible' => 1], $p['excluded']);
        $this->assertSame(2, $p['recipients']);
        $this->assertEquals(['good' => 50.0, 'careful' => 50.0, 'risky' => 0.0], $p['risk_breakdown']);

        $all = $this->preview($h, $store, ['segment' => 'all', 'params' => []]);
        $this->assertSame(['risky' => 0, 'recent_orders' => 0, 'opted_out' => 1, 'no_address' => 1, 'not_eligible' => 1], $all['excluded']);
        $this->assertSame(4, $all['recipients']);
        $this->assertEquals(['good' => 50.0, 'careful' => 25.0, 'risky' => 25.0], $all['risk_breakdown']);

        // Email channel: different address column; the SMS opt-out doesn't apply.
        $email = $this->preview($h, $store, ['segment' => 'all', 'params' => []], 'email');
        $this->assertSame(1, $email['recipients']);
        $this->assertSame(6, $email['excluded']['no_address']);
    }

    /** P85-3: (accepts_marketing, orders, suppressed) → eligible. */
    public static function eligibility(): array
    {
        return [
            'opted in, no orders' => [true, 0, false, true],
            'not opted in, has ordered' => [false, 1, false, true],
            'not opted in, no orders' => [false, 0, false, false],
            'opted in, suppressed' => [true, 3, true, false],
            'ordered, suppressed' => [false, 2, true, false],
        ];
    }

    #[DataProvider('eligibility')]
    public function test_eligibility_matrix(bool $accepts, int $orders, bool $suppressed, bool $eligible): void
    {
        [, , $store, $h] = $this->campaignShop();
        $c = $this->customer($h, $store, ['accepts_marketing' => $accepts], ['orders_count' => $orders]);
        if ($suppressed) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$c->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();
        }
        $this->assertSame($eligible ? 1 : 0, $this->preview($h, $store, ['segment' => 'all', 'params' => []])['recipients']);
        $expected = $suppressed ? 'unsubscribed' : ($eligible ? 'subscribed' : 'not_eligible');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$c->id}")->assertOk()
            ->assertJsonPath('data.marketing.sms', $expected)->assertJsonPath('data.marketing.email', 'no_address');
    }

    /** PHASE-8-8 P88-3/P88-4 (§6.6): the 8.5 classes now come from RiskTier (CustomerRisk is a deprecated alias). */
    public function test_risk_classes(): void
    {
        $this->assertSame('new', CustomerRisk::classify(0, 0)); // was good
        $this->assertSame('good', CustomerRisk::classify(4, 1)); // 80 %
        $this->assertSame('good', CustomerRisk::classify(3, 1)); // 75 %: was careful
        $this->assertSame('careful', CustomerRisk::classify(0, 1)); // one parcel, returned: no ratio verdict
        $this->assertSame('careful', CustomerRisk::classify(0, 2)); // 2 returned / 0 delivered: was risky (total < 3)
        $this->assertSame('careful', CustomerRisk::classify(3, 2)); // 60 %: not below the hold line (60), below 75
        $this->assertSame('risky', CustomerRisk::classify(2, 2)); // 50 %: stays risky
        $this->assertSame('careful', CustomerRisk::classify(6, 3)); // 67 %: stays careful
        $this->assertSame('risky', CustomerRisk::classify(0, 5));
        $this->assertSame(RiskTier::classify(2, 2), CustomerRisk::classify(2, 2));
    }
}
