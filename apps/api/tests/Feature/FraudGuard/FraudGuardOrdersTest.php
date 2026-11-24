<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\FraudGuard\FraudGuard;
use App\Domain\FraudGuard\Jobs\CheckOrderRisk;
use App\Domain\FraudGuard\Models\OrderRiskCheck;
use App\Domain\Orders\Models\Order;
use App\Domain\Payments\Models\PaymentLink;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8 §5 order checks: one check per order (S157), the P88-5 decision matrix, hold enforcement on every path
 * (S156), the advance through the existing payment link (S158), duplicates (P88-12), own-shop data only (S161).
 */
#[Group('fraud')]
#[Group('orders')]
class FraudGuardOrdersTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpGuard();
    }

    private const PHONE = '01755000111';

    /** @return array<string, array{0: int, 1: int, 2: array<string, bool>, 3: bool, 4: string, 5: string|null, 6: list<string>}> */
    public static function matrix(): array
    {
        // delivered, returned, settings, gateway → decision, hold, reasons
        return [
            'new number → none' => [0, 0, [], true, 'none', null, ['new_number']],
            'good → none' => [4, 0, [], true, 'none', null, []],
            'risky + hold on → call_first' => [1, 2, [], true, 'hold', 'call_first', ['rate_below_hold']],
            'risky + hold off + advance on → advance' => [1, 2, ['hold_enabled' => false], true, 'advance', 'advance', ['rate_below_hold']],
            'risky + hold off + advance off → none' => [1, 2, ['hold_enabled' => false, 'advance_enabled' => false], true, 'none', null, ['rate_below_hold']],
            'careful + advance on + gateway → advance' => [6, 3, [], true, 'advance', 'advance', ['rate_below_advance']],
            'careful + advance on + no gateway → call_first (no_gateway)' => [6, 3, [], false, 'hold', 'call_first', ['rate_below_advance', 'no_gateway']],
            'careful + advance off → none' => [6, 3, ['advance_enabled' => false], true, 'none', null, ['rate_below_advance']],
            'thin careful (1 returned) → advance' => [0, 1, [], true, 'advance', 'advance', ['few_parcels']],
        ];
    }

    /** @param array<string, bool> $settings @param list<string> $reasons */
    #[DataProvider('matrix')]
    public function test_decision_matrix(int $delivered, int $returned, array $settings, bool $gateway, string $decision, ?string $hold, array $reasons): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(gateway: $gateway, settings: ['otp_enabled' => false, 'block_returners' => false] + $settings);
        $this->history($tenant, $store, $h, $variant, self::PHONE, $delivered, $returned);

        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $order = $this->orderOf($tenant, $number);
        $guard = $this->api($h, 'GET', $this->oUrl($store, $order->id))->assertOk()->json('data.guard');

        $this->assertSame($hold, $guard['hold']);
        $this->assertSame($decision, $guard['decision']);
        $this->assertSame($reasons, $guard['reasons']);
        $this->assertSame(['total' => $delivered + $returned, 'delivered' => $delivered, 'sources' => [['key' => 'shop', 'delivered' => $delivered, 'total' => $delivered + $returned]]], $guard['record']);
        $this->assertNotNull($guard['checked_at']);
        $this->assertSame($decision === 'advance', $guard['payment_link_id'] !== null);
        $this->assertSame('pending', $this->orderOf($tenant, $number)->status);
        $events = $this->api($h, 'GET', $this->oUrl($store, $order->id))->json('data.events');
        $this->assertSame($decision, collect($events)->firstWhere('type', 'guard')['meta']['decision']);
    }

    public function test_held_order_cannot_be_confirmed_or_booked_on_any_path_until_released(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 1, 2);
        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $id = $this->orderOf($tenant, $number)->id;
        $other = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');

        $detail = $this->api($h, 'GET', $this->oUrl($store, $id))->assertOk()->json('data');
        $this->assertSame('call_first', $detail['guard']['hold']);
        $this->assertNotContains('confirmed', $detail['allowed_transitions']);

        // single confirm, bulk confirm, ready, booking (single + bulk), external API
        $this->api($h, 'POST', $this->oUrl($store, $id, '/confirm'))->assertStatus(409)->assertJsonPath('error.code', 'order_held');
        $bulk = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/bulk", ['action' => 'confirm', 'ids' => [$id, $other]])->assertOk()->json('data');
        $this->assertSame(1, $bulk['updated']);
        $this->assertSame([['id' => $id, 'reason' => 'order_held']], $bulk['skipped']);
        $this->api($h, 'POST', $this->oUrl($store, $id, '/ready'))->assertStatus(409)->assertJsonPath('error.code', 'order_held');
        $this->book($h, $store, $id)->assertStatus(409)->assertJsonPath('error.code', 'order_held');
        $batch = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$id]])->assertStatus(202)->json('data.id');
        $this->assertSame('order_held', $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipment-batches/{$batch}")->json('data.results.0.reason'));
        $this->externalConfirm($tenant, $store, $h, $id)->assertStatus(409)->assertJsonPath('error.code', 'order_held');
        $this->assertSame('pending', $this->orderOf($tenant, $number)->status);

        // edits, notes and cancel stay allowed; release → everything works
        $this->api($h, 'POST', $this->oUrl($store, $id, '/notes'), ['body' => 'Called — no answer'])->assertCreated();
        $this->api($h, 'POST', $this->oUrl($store, $other, '/guard/release'))->assertStatus(409)->assertJsonPath('error.code', 'order_not_held');
        $released = $this->api($h, 'POST', $this->oUrl($store, $id, '/guard/release'))->assertOk()->json('data');
        $this->assertNull($released['guard']['hold']);
        $this->assertSame('hold', $released['guard']['decision']);
        $this->assertContains('confirmed', $released['allowed_transitions']);
        $this->api($h, 'POST', $this->oUrl($store, $id, '/confirm'))->assertOk()->assertJsonPath('data.status', 'confirmed');
        $this->book($h, $store, $id)->assertCreated();

        $this->assertSame(['held', 'released'], $this->guardEvents($tenant));
        $this->assertNotNull($this->checkOf($tenant, $id)?->released_at);
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'fraud.hold_released')->count());
        $timeline = collect($this->api($h, 'GET', $this->oUrl($store, $id))->json('data.events'))->where('type', 'guard')->values();
        $this->assertTrue($timeline->contains(fn ($e) => ($e['meta']['released'] ?? false) === true));
    }

    /** PHASE-8-4 external API `POST /orders/{order}/status {confirmed}` (Growth: API keys + the guard). */
    private function externalConfirm($tenant, $store, array $h, string $orderId)
    {
        $this->planFor($tenant, 'growth');
        $plain = $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'ERP', 'scopes' => ['orders:write']])->assertCreated()->json('data.plain_key');

        return $this->flushHeaders()->withHeaders(['Authorization' => 'Bearer '.$plain, 'Idempotency-Key' => (string) Str::uuid(), 'Origin' => 'https://integrations.example.test'])
            ->postJson("/api/v1/external/stores/{$store->id}/orders/{$orderId}/status", ['status' => 'confirmed']);
    }

    public function test_advance_paid_releases_and_confirms_once_and_expiry_goes_back_to_call_first(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false, 'advance_cancel_if_unpaid' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 6, 3);
        $sms = count($this->smsSent());

        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $id = $this->orderOf($tenant, $number)->id;
        $order = $this->api($h, 'GET', $this->oUrl($store, $id))->json('data');
        $this->assertSame('advance', $order['guard']['hold']);
        $link = collect($order['payment_links'])->firstWhere('id', $order['guard']['payment_link_id']);
        $this->assertSame(['delivery_charge', 7000, 'bkash'], [$link['amount_kind'], $link['amount'], $link['provider']]);
        $this->assertTrue(collect(array_slice($this->smsSent(), $sms))->contains(fn ($m) => str_contains($m['text'], $link['url'])), 'link SMS sent');
        $this->api($h, 'POST', $this->oUrl($store, $id, '/confirm'))->assertStatus(409)->assertJsonPath('error.code', 'order_held');

        // Paid → released + confirmed once.
        $token = substr($link['url'], -12);
        $init = $this->sf($store, 'POST', "/payment-links/{$token}/pay", [], null, ['Idempotency-Key' => (string) Str::uuid()])->assertOk()->json('data');
        $this->payOnline($tenant, $init['payment_id'])->assertStatus(303);
        $this->payOnline($tenant, $init['payment_id']);
        $after = $this->api($h, 'GET', $this->oUrl($store, $id))->json('data');
        $this->assertSame('confirmed', $after['status']);
        $this->assertNull($after['guard']['hold']);
        $this->assertSame(['advance_asked', 'advance_paid'], $this->guardEvents($tenant));
        $this->assertSame(7000, $this->api($h, 'GET', $this->gUrl($store, '/overview'))->json('data.advance_collected_amount'));

        // A second careful order (another item: not a duplicate): the link expires unpaid → back to call_first (not cancelled).
        [, $other] = $this->stocked($h, $store);
        $number2 = $this->sfCheckout($store, $other, self::PHONE)->assertCreated()->json('data.order.number');
        $this->assertSame('advance', $this->orderOf($tenant, $number2)->guard_hold);
        $this->travel(1441)->minutes();
        $this->artisan('payment-links:expire')->assertSuccessful();
        $o2 = $this->orderOf($tenant, $number2);
        $this->assertSame(['pending', 'call_first'], [$o2->status, $o2->guard_hold]);
    }

    public function test_cancel_if_unpaid_cancels_a_held_advance_order_and_clears_the_hold(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false, 'advance_expiry_minutes' => 120]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 0, 1);
        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $this->travel(121)->minutes();
        $this->artisan('payment-links:expire')->assertSuccessful();
        $o = $this->orderOf($tenant, $number);
        $this->assertSame([Order::CANCELLED, 'payment_link_expired', null], [$o->status, $o->cancel_reason, $o->guard_hold]);
    }

    public function test_release_of_an_advance_hold_cancels_the_guard_link_then_confirm_works(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 6, 3);
        $id = $this->orderOf($tenant, $this->sfCheckout($store, $variant, self::PHONE)->json('data.order.number'))->id;
        $this->api($h, 'POST', $this->oUrl($store, $id, '/guard/release'))->assertOk();
        $this->api($h, 'POST', $this->oUrl($store, $id, '/confirm'))->assertOk();
        $this->assertSame(PaymentLink::CANCELLED, $this->inTenant($tenant, fn () => PaymentLink::query()->where('order_id', $id)->value('status')));
    }

    public function test_duplicate_same_phone_same_variant_in_window_is_held_never_cancelled(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'daily_limit' => 10]);
        [, $other] = $this->stocked($h, $store);
        $first = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $differentItem = $this->sfCheckout($store, $other, self::PHONE)->assertCreated()->json('data.order.number');
        $dupe = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');

        $this->assertNull($this->orderOf($tenant, $first)->guard_hold);
        $this->assertNull($this->orderOf($tenant, $differentItem)->guard_hold);
        $d = $this->orderOf($tenant, $dupe);
        $this->assertSame(['pending', 'call_first'], [$d->status, $d->guard_hold]);
        $check = $this->checkOf($tenant, $d->id);
        $this->assertSame($this->orderOf($tenant, $first)->id, $check->duplicate_of);
        $this->assertContains('duplicate', $check->reasons);
        $event = $this->api($h, 'GET', $this->gUrl($store, '/events?filter[type]=duplicate'))->assertOk()->json('data.0');
        $this->assertSame(['id' => $d->id, 'number' => $dupe], $event['order']);
        $this->assertSame($first, $event['detail']['duplicate_of_number']);
        $this->assertSame(24, $event['detail']['window_hours']);

        // Outside the window: no duplicate.
        $this->travel(25)->hours();
        $later = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $this->assertNull($this->orderOf($tenant, $later)->guard_hold);
    }

    public function test_one_check_per_order_even_with_retries_and_stale_checking_is_resolved_once(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 6, 3);
        $id = $this->orderOf($tenant, $this->sfCheckout($store, $variant, self::PHONE)->json('data.order.number'))->id;
        $this->inTenant($tenant, function () use ($id) {
            dispatch_sync(new CheckOrderRisk($id));
            app(FraudGuard::class)->check($id);
        });
        $this->assertSame(1, $this->inTenant($tenant, fn () => OrderRiskCheck::query()->where('order_id', $id)->count()));
        $this->assertSame(1, $this->inTenant($tenant, fn () => PaymentLink::query()->where('order_id', $id)->count()));
        $this->assertSame(['advance_asked'], $this->guardEvents($tenant));

        // A lost job: the order stays `checking` → the sweep resolves it after 10 minutes, once.
        Queue::fake([CheckOrderRisk::class]);
        $lost = $this->orderOf($tenant, $this->sfCheckout($store, $variant, '01755000222')->json('data.order.number'));
        $this->assertSame('checking', $lost->guard_hold);
        $this->api($h, 'POST', $this->oUrl($store, $lost->id, '/confirm'))->assertStatus(409)->assertJsonPath('error.code', 'order_held');
        $this->assertSame('checking', $this->api($h, 'GET', $this->oUrl($store, $lost->id))->json('data.guard.hold'));
        $this->assertNull($this->api($h, 'GET', $this->oUrl($store, $lost->id))->json('data.guard.tier'));
        $this->artisan('fraud:resolve-stale')->assertSuccessful();
        $this->assertSame('checking', $this->orderOf($tenant, $lost->number)->guard_hold, 'not stale yet');
        $this->travel(11)->minutes();
        $this->artisan('fraud:resolve-stale')->assertSuccessful();
        $this->artisan('fraud:resolve-stale')->assertSuccessful();
        $this->assertNull($this->orderOf($tenant, $lost->number)->guard_hold);
        $this->assertSame(1, $this->inTenant($tenant, fn () => OrderRiskCheck::query()->where('order_id', $lost->id)->count()));
    }

    public function test_manual_online_and_unguarded_orders_get_a_check_without_actions(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 0, 3);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => self::PHONE])->assertCreated();
        $manual = $this->manual($h, $store, $this->manualBody($variant, 1, ['contact' => ['phone' => self::PHONE]]))->assertCreated()->json('data');
        $this->assertNull($manual['guard']['hold']);
        $this->assertSame(['skipped', 'risky'], [$manual['guard']['decision'], $manual['guard']['tier']]);
        $this->assertContains('blocked_number', $manual['guard']['reasons']); // Q196: allowed, badged
        $this->api($h, 'POST', $this->oUrl($store, $manual['id'], '/confirm'))->assertOk();

        $online = $this->onlineCheckout($store, $variant, 'bkash', ['contact' => ['phone' => self::PHONE]])->assertCreated()->json('data.order.number');
        $this->assertSame('skipped', $this->checkOf($tenant, $this->orderOf($tenant, $online)->id)->decision);

        $this->guardSettings($h, $store, ['enabled' => false])->assertOk();
        $this->api($h, 'DELETE', $this->gUrl($store, '/blocked-numbers/'.$this->api($h, 'GET', $this->gUrl($store, '/blocked-numbers'))->json('data.0.id')))->assertNoContent();
        $off = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $o = $this->orderOf($tenant, $off);
        $this->assertNull($o->guard_hold);
        $this->assertSame('skipped', $this->checkOf($tenant, $o->id)->decision);
        $this->assertSame([], array_values(array_filter($this->guardEvents($tenant), fn ($t) => $t === 'held')));
    }

    public function test_free_plan_store_has_no_checks_with_actions_but_tiers_still_show(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 1, 2);
        $this->planFor($tenant, 'free');
        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $guard = $this->api($h, 'GET', $this->oUrl($store, $this->orderOf($tenant, $number)->id))->json('data.guard');
        $this->assertSame([null, 'skipped', 'risky'], [$guard['hold'], $guard['decision'], $guard['tier']]);
        $this->assertSame('risky', $this->api($h, 'GET', $this->oUrl($store, $this->orderOf($tenant, $number)->id))->json('data.customer.risk.tier'));
    }

    public function test_record_is_own_shop_only_with_no_external_call(): void
    {
        Http::preventStrayRequests();
        [, $tenantA, $storeA, $hA, $variantA] = $this->guardShop('alpha', settings: ['otp_enabled' => false, 'block_returners' => false]);
        [, $tenantB, $storeB, $hB, $variantB] = $this->guardShop('beta', settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenantB, $storeB, $hB, $variantB, self::PHONE, 0, 5); // a terrible record — at ANOTHER shop
        $this->history($tenantA, $storeA, $hA, $variantA, self::PHONE, 4, 0);

        $number = $this->sfCheckout($storeA, $variantA, self::PHONE)->assertCreated()->json('data.order.number');
        $guard = $this->api($hA, 'GET', $this->oUrl($storeA, $this->orderOf($tenantA, $number)->id))->json('data.guard');
        $this->assertSame(['good', 4, 4, null], [$guard['tier'], $guard['record']['total'], $guard['record']['delivered'], $guard['hold']]);
        $this->assertSame('good', $this->api($hA, 'POST', $this->gUrl($storeA, '/check'), ['phone' => self::PHONE])->json('data.tier'));
    }

    public function test_order_list_risk_and_hold_filters_and_held_count(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'block_returners' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 1, 2);
        $held = $this->orderOf($tenant, $this->sfCheckout($store, $variant, self::PHONE)->json('data.order.number'));
        $fresh = $this->orderOf($tenant, $this->sfCheckout($store, $variant, '01755000999')->json('data.order.number'));

        $list = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[guard_hold]=1")->assertOk();
        $this->assertSame([$held->id], array_column($list->json('data'), 'id'));
        $this->assertSame(1, $list->json('meta.counts.held'));
        $this->assertSame('call_first', $list->json('data.0.guard.hold'));
        $this->assertSame('risky', $list->json('data.0.customer.risk.tier'));

        $risky = array_column($this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[risk]=risky")->json('data'), 'id');
        $this->assertContains($held->id, $risky);
        $this->assertNotContains($fresh->id, $risky);
        $this->assertContains($fresh->id, array_column($this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[risk]=new")->json('data'), 'id'));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[risk]=bad")->assertStatus(422);

        // Customer list filter + payload.
        $customers = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers?filter[risk]=risky")->assertOk()->json('data');
        $this->assertSame([self::msisdn(self::PHONE)], array_column($customers, 'phone'));
        $this->assertSame(['tier' => 'risky', 'rate' => 33, 'delivered' => 1, 'total' => 3], $customers[0]['risk']);
    }

    public function test_repeat_returner_is_auto_blocked_once_and_an_unblock_is_never_re_added(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false]);
        $this->history($tenant, $store, $h, $variant, self::PHONE, 0, 2);
        $this->assertSame(0, $this->blockedRows($tenant));
        // A third return through the order flow → automatic block (after commit).
        $id = $this->confirmedOrder($h, $store, $variant, 1, ['contact' => ['phone' => self::PHONE]]);
        $this->api($h, 'POST', $this->oUrl($store, $id, '/ship'), [])->assertOk();
        $this->api($h, 'POST', $this->oUrl($store, $id, '/return'), ['restock' => []])->assertOk();
        $this->assertSame(1, $this->blockedRows($tenant));
        $entry = $this->api($h, 'GET', $this->gUrl($store, '/blocked-numbers'))->json('data.0');
        $this->assertSame(['repeat_returns', 'auto', null, 3], [$entry['reason'], $entry['source'], $entry['created_by'], $entry['returned_count']]);
        $this->assertSame(['auto_blocked'], $this->guardEvents($tenant, 'auto_blocked'));
        $this->assertSame(3, $this->api($h, 'GET', $this->gUrl($store, '/events?filter[type]=auto_blocked'))->json('data.0.detail.returned_count'));

        $this->sfCheckout($store, $variant, self::PHONE)->assertStatus(422)->assertJsonPath('error.code', 'cod_unavailable');
        $this->api($h, 'DELETE', $this->gUrl($store, '/blocked-numbers/'.$entry['id']))->assertNoContent();
        $this->sfCheckout($store, $variant, self::PHONE)->assertCreated();
        $this->assertSame(0, $this->blockedRows($tenant), 'the merchant unblock is remembered');
    }
}
