<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-6 §7 checkout recovery: cart contact (S132), detect-abandoned, the 2-step flow, the cart-restore link
 * (S133), exit on order + attribution (P86-14/15) from carts and unfinished online orders, opt-out (S127), window end,
 * frequency cap (S134), stats + overview (each order once).
 */
#[Group('automations')]
#[Group('security')]
class CheckoutRecoveryTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase;

    private const EN = [
        'step1' => ['message' => ['language' => 'en', 'body' => 'Hi {name}, finish your order: {cart_link}']],
        'step2' => ['message' => ['language' => 'en', 'body' => 'Last call {name}: {cart_link}']],
    ];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_s132_cart_contact_is_saved_only_with_the_cart_token_and_never_echoed(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $cart = $this->cartWith($store, $variant);

        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009', 'name' => ' Rafi ', 'email' => 'Rafi@Example.TEST'], $cart)->assertNoContent();
        $row = $this->platformQuery(Cart::class)->where('tenant_id', $tenant->id)->firstOrFail();
        $this->assertSame(['8801711000009', 'Rafi', 'rafi@example.test'], [$row->contact_phone, $row->contact_name, $row->contact_email]);
        $this->assertNotNull($row->contact_captured_at);
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '+8801711000010'], $cart)->assertNoContent();
        $row->refresh();
        $this->assertSame(['8801711000010', 'Rafi'], [$row->contact_phone, $row->contact_name], 'phone overwritten, name kept when not sent');

        $view = $this->sf($store, 'GET', '/cart', [], $cart)->assertOk()->getContent();
        $this->assertStringNotContainsString('1711000010', (string) $view);
        $this->assertStringNotContainsString('Rafi', (string) $view);

        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '12345'], $cart)->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'])->assertNotFound()->assertJsonPath('error.code', 'cart_not_found');
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'], str_repeat('a', 43))->assertNotFound();
        $item = $this->inTenant($tenant, fn () => CartItem::query()->value('id'));
        $this->sf($store, 'DELETE', "/cart/items/{$item}", [], $cart)->assertOk();
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'], $cart)->assertNotFound()->assertJsonPath('error.code', 'cart_not_found');

        // Another store's host never sees this cart.
        [, , $storeB] = $this->campaignShop(slug: 'beta');
        $this->sf($storeB, 'PUT', '/cart/contact', ['phone' => '01711000009'], $cart)->assertNotFound();

        // Deleted with the cart (90-day prune).
        $this->platformQuery(Cart::class)->whereKey($row->id)->update(['status' => 'abandoned', 'last_activity_at' => now()->subDays(91)]);
        $this->artisan('carts:prune')->assertSuccessful();
        $this->assertSame(0, $this->platformQuery(Cart::class)->whereKey($row->id)->count());
    }

    public function test_s132_contact_limiter_and_draft_store(): void
    {
        $this->withMiddleware(ThrottleRequests::class); // setUp turned throttles off
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $cart = $this->cartWith($store, $variant);
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.7'];
        for ($i = 0; $i < 10; $i++) {
            $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'], $cart, $ip)->assertNoContent();
        }
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'], $cart, $ip)->assertStatus(429);
        // S133: the recover limiter is 20/min per shopper IP.
        for ($i = 0; $i < 20; $i++) {
            $this->recover($store, 'AAAAAAAAAA', $ip)->assertNotFound();
        }
        $this->recover($store, 'AAAAAAAAAA', $ip)->assertStatus(429);

        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => '01711000009'], $cart)->assertNotFound();
    }

    public function test_detect_send_restore_and_convert(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 10);
        $a = $this->automationOn($h, $store, 'checkout_recovery', self::EN);
        $cart = $this->contactCart($store, $variant, '01711000001', ['name' => 'Rafi Ahmed']);

        $this->detect();
        $this->assertCount(0, $this->runsOf($tenant), 'not idle long enough');
        $this->travel(31)->minutes();
        $this->detect();
        $this->detect(); // twice: the cart is marked once
        $runs = $this->runsOf($tenant, $a['id']);
        $this->assertCount(1, $runs);
        $run = $runs[0];
        $this->assertSame(['waiting', 'cart', '8801711000001', 2], [$run->status, $run->subject_type, $run->contact_address, $run->next_step]);
        $this->assertStringStartsWith('checkout:8801711000001:2026-11-24', $run->dedupe_key);
        $this->assertSame(64, strlen((string) $run->recovery_code_hash));
        $this->assertSame([['send_message', 'done', ['message_step' => 1]]], $this->stepsOf($tenant, $run->id)->map(fn ($s) => [$s->action, $s->status, $s->detail])->all());
        $text = $this->sms()->sent[0]['text'];
        $this->assertStringContainsString('Hi Rafi, finish your order: https://'.$store->slug.'.storeplix.test/r/', $text);
        $code = $this->cartCodeIn($text);
        $this->assertSame(hash('sha256', $code), $run->recovery_code_hash, 'only the hash is stored');
        $this->assertSame(1, $this->platformQuery(Cart::class)->whereNotNull('recovery_detected_at')->count());

        // S133: the link clones the cart; the original token and cart are untouched.
        $restored = $this->recover($store, $code)->assertCreated()->assertHeader('Cache-Control', 'no-store, private')->json('data');
        $this->assertSame('checkout', $restored['next']);
        $this->assertNotSame($cart, $restored['cart_token']);
        $this->sf($store, 'GET', '/cart', [], $cart)->assertOk()->assertJsonPath('data.lines.0.quantity', 1);
        $this->sf($store, 'GET', '/cart', [], $restored['cart_token'])->assertOk()->assertJsonPath('data.lines.0.variant_id', $variant);
        $this->assertSame(2, $this->platformQuery(Cart::class)->where('tenant_id', $tenant->id)->count());
        $this->recover($store, 'AAAAAAAAAA')->assertNotFound()->assertJsonPath('error.code', 'recovery_link_invalid');
        $this->recover($store, 'bad code!')->assertNotFound();
        [, , $storeB] = $this->campaignShop(slug: 'beta');
        $this->recover($storeB, $code)->assertNotFound();

        // Order from the restored cart (same phone) → stopped/converted + one conversion credited to step 1.
        $total = $this->sf($store, 'GET', '/cart', [], $restored['cart_token'])->json('data.estimated_total_amount');
        $placed = $this->checkout($store, $restored['cart_token'], $this->checkoutBody($total + 7000))->assertCreated()->json('data.order');
        $run->refresh();
        $this->assertSame(['stopped', 'converted'], [$run->status, $run->outcome_reason]);
        $conversion = $this->platformQuery(AutomationConversion::class)->where('tenant_id', $tenant->id)->firstOrFail();
        $this->assertSame([$a['id'], $run->id, $this->stepsOf($tenant, $run->id)[0]->id], [$conversion->automation_id, $conversion->run_id, $conversion->step_id]);
        $this->recover($store, $code)->assertNotFound(); // stopped run

        $orderTotal = (int) $this->platformQuery(Order::class)->where('number', $placed['number'])->value('total_amount');
        $api = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs?filter[automation_id]={$a['id']}")->assertOk();
        $api->assertJsonPath('data.0.conversion.order.number', $placed['number'])->assertJsonPath('data.0.subject.label', 'Cart · 1 item');
        $stats = $this->api($h, 'GET', $this->aUrl($store, "/{$a['id']}/stats?days=14"))->assertOk()->json('data');
        $this->assertSame([['step' => 1, 'sent' => 1, 'recovered' => 1, 'revenue_amount' => $orderTotal], ['step' => 2, 'sent' => 0, 'recovered' => 0, 'revenue_amount' => 0]], $stats['steps']);
        $this->assertCount(14, $stats['daily']);
        $this->assertSame(1, $stats['daily'][13]['recovered']);
        $this->assertSame(['carts_left_behind' => 1, 'carts_left_behind_amount' => 100000, 'recovered' => 1, 'recovery_rate_pct' => 100, 'revenue_amount' => $orderTotal, 'average_recovered_amount' => $orderTotal, 'messages_sent_month' => 1], $stats['kpis']);
        $this->api($h, 'GET', $this->aUrl($store, "/{$a['id']}/stats?days=30"))->assertOk()->assertJsonCount(30, 'data.daily');
        $this->api($h, 'GET', $this->aUrl($store, "/{$a['id']}/stats?days=7"))->assertStatus(422);

        $overview = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/marketing/overview?range=7d")->assertOk()->json('data');
        $this->assertSame([1, $orderTotal, $orderTotal, 1], [$overview['kpis']['carts_recovered'], $overview['kpis']['recovered_revenue_amount'], $overview['kpis']['revenue_amount'], $overview['counts']['automations']]);
        $this->assertSame($orderTotal, array_sum(array_column($overview['series'], 'recovery_amount')));

        // Cancelled orders are excluded at read time.
        $this->platformQuery(Order::class)->where('number', $placed['number'])->update(['status' => 'cancelled']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/marketing/overview?range=7d")->assertJsonPath('data.kpis.carts_recovered', 0);
    }

    public function test_second_step_with_coupon_and_restore_applies_it(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 10);
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'BACK10', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active'])->assertCreated()->json('data.id');
        $a = $this->automationOn($h, $store, 'checkout_recovery', self::EN + ['wait_hours' => 6]);
        $a = $this->api($h, 'PATCH', $this->aUrl($store, "/{$a['id']}"), ['settings' => array_replace_recursive($a['settings'], ['step2' => ['coupon_id' => $coupon, 'message' => ['body' => 'Take {coupon} off: {cart_link}']]]), 'revision' => $a['revision']])
            ->assertOk()->json('data');
        $this->contactCart($store, $variant);
        $this->travel(31)->minutes();
        $this->detect();
        $run = $this->runsOf($tenant)->first();
        $this->travel(6)->hours();
        $this->resumeDue();
        $run->refresh();
        $this->assertSame(['waiting', 4], [$run->status, $run->next_step], 'after step 2 the run waits for the exit window');
        $steps = $this->stepsOf($tenant, $run->id);
        $this->assertSame([1, 2], $steps->pluck('step_index')->all());
        $this->assertEqualsCanonicalizing(['message_step' => 2, 'coupon_code' => 'BACK10'], $steps[1]->detail);
        $this->assertStringContainsString('Take BACK10 off:', $this->sms()->sent[1]['text']);
        $this->assertSame($this->cartCodeIn($this->sms()->sent[0]['text']), $this->cartCodeIn($this->sms()->sent[1]['text']), 'one link per run');

        $token = $this->recover($store, $this->cartCodeIn($this->sms()->sent[1]['text']))->assertCreated()->json('data.cart_token');
        $this->sf($store, 'GET', '/cart', [], $token)->assertOk()->assertJsonPath('data.coupon.code', 'BACK10');

        // The window ends → completed.
        $this->travel(3)->days();
        $this->resumeDue();
        $this->assertSame(['completed', null], [$run->refresh()->status, $run->outcome_reason]);
        $this->recover($store, $this->cartCodeIn($this->sms()->sent[1]['text']))->assertNotFound();
    }

    public function test_s127_opt_out_from_the_message_stops_the_flow(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'checkout_recovery', self::EN);
        $this->contactCart($store, $variant);
        $this->travel(31)->minutes();
        $this->detect();
        $code = $this->codeIn($this->sms()->sent[0]['text']);

        $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk()->assertJsonPath('data.status', 'subscribed')->assertJsonPath('data.is_test', false)
            ->assertJsonPath('data.masked_address', '+880 17•• •••001');
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk()->assertJsonPath('data.status', 'unsubscribed');
        $row = $this->platformQuery(MarketingSuppression::class)->where('tenant_id', $tenant->id)->firstOrFail();
        $this->assertSame(['sms', '8801711000001', 'link', null], [$row->channel, $row->address, $row->source, $row->campaign_id]);

        $this->travel(24)->hours();
        $this->resumeDue();
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['stopped', 'opted_out'], [$run->status, $run->outcome_reason]);
        $this->assertSame(['done', 'skipped'], $this->stepsOf($tenant, $run->id)->pluck('status')->all());
        $this->assertSame('opted_out', $this->stepsOf($tenant, $run->id)[1]->reason);
        $this->assertCount(1, $this->sms()->sent, 'the provider was never called for step 2');
    }

    public function test_window_end_stops_before_step_two(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'checkout_recovery', self::EN + ['wait_hours' => 48, 'exit_days' => 1]);
        $this->contactCart($store, $variant);
        $this->travel(31)->minutes();
        $this->detect();
        $code = $this->cartCodeIn($this->sms()->sent[0]['text']);
        $this->travel(25)->hours();
        $this->recover($store, $code)->assertNotFound(); // S133: expired
        $this->travel(23)->hours();
        $this->resumeDue();
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['stopped', 'window_ended'], [$run->status, $run->outcome_reason]);
        $this->assertCount(1, $this->sms()->sent);
    }

    public function test_unfinished_online_order_feeds_the_same_flow_once_per_phone(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->connectFakeBkash($tenant, $store);
        $a = $this->automationOn($h, $store, 'checkout_recovery', self::EN);
        $cart = $this->cartWith($store, $variant);
        $total = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.estimated_total_amount') + 7000;
        $number = $this->checkout($store, $cart, $this->checkoutBody($total, ['payment_method' => 'bkash']))->assertCreated()->json('data.order.number');
        $this->travel(31)->minutes();
        $this->artisan('payments:expire')->assertSuccessful();
        $this->assertSame('cancelled', $this->platformQuery(Order::class)->where('number', $number)->value('status'));

        $run = $this->runsOf($tenant, $a['id'])->first();
        $this->assertNotNull($run);
        $this->assertSame(['order', '8801711000001', 'waiting'], [$run->subject_type, $run->contact_address, $run->status]);
        $this->assertCount(1, $this->sms()->sent);

        // The same shopper leaves a cart later the same day: the open flow owns the phone → no second run.
        $this->contactCart($store, $variant, '01711000001');
        $this->travel(31)->minutes();
        $this->detect();
        $this->assertCount(1, $this->runsOf($tenant, $a['id']));

        // Restoring an unfinished order rebuilds its lines into a new cart.
        $token = $this->recover($store, $this->cartCodeIn($this->sms()->sent[0]['text']))->assertCreated()->json('data.cart_token');
        $this->sf($store, 'GET', '/cart', [], $token)->assertOk()->assertJsonPath('data.lines.0.variant_id', $variant);
    }

    public function test_s134_frequency_cap_across_automations(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        $this->automationOn($h, $store, 'thank_you');
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        $runs = $this->runsOf($tenant);
        $this->assertSame(['done', 'done', 'skipped'], $runs->map(fn ($r) => $this->stepsOf($tenant, $r->id)[0]->status)->all());
        $this->assertSame('frequency_cap', $this->stepsOf($tenant, $runs[2]->id)[0]->reason);
        $this->assertSame('completed', $runs[2]->status);
        $this->travel(25)->hours();
        $this->deliveredOrder($h, $store, $variant);
        $this->assertSame('done', $this->stepsOf($tenant, $this->runsOf($tenant)[3]->id)[0]->status, 'rolling 24 h');
    }
}
