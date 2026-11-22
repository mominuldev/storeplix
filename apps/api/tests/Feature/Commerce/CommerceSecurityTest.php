<?php

namespace Tests\Feature\Commerce;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Shared\Idempotency\IdempotencyKey;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use LogicException;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** PHASE-5 §10 security checklist (S1, S4, S5, S8, S9, S11, S15, S17) plus the Postgres race tests (S2, S3, S4). */
#[Group('security')]
class CommerceSecurityTest extends TestCase
{
    use CommerceFixtures, ForksRaces, RefreshDatabase;

    /** S1: prices, discounts and totals come from the database; a tampered expected total writes nothing. */
    public function test_checkout_price_tampering(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5);
        $cart = $this->cartWith($store, $variant, 1);
        $body = $this->checkoutBody(107000) + ['unit_price_amount' => 1, 'discount_amount' => 99999, 'total_amount' => 1, 'shipping_amount' => 0,
            'lines' => [['variant_id' => $variant, 'unit_price_amount' => 1]]];
        $this->checkout($store, $cart, ['expected_total_amount' => 1] + $body)->assertStatus(409)->assertJsonPath('error.code', 'checkout_changed');
        $this->assertSame(0, Order::withoutTenancy()->count());
        $this->tenancy()->run($tenant, fn () => $this->assertSame(0, Inventory::query()->where('variant_id', $variant)->value('committed')));
        $this->checkout($store, $cart, $body)->assertCreated()->assertJsonPath('data.order.subtotal_amount', 100000)
            ->assertJsonPath('data.order.discount_amount', 0)->assertJsonPath('data.order.total_amount', 107000);
    }

    /** S11: mass-assignment probes on checkout, manual order, PATCH order and coupons. */
    public function test_mass_assignment_probes(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, , $other] = $this->liveShop('other');
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $probe = ['status' => 'delivered', 'payment_status' => 'paid', 'number' => 'HACK-1', 'sequence' => 1, 'revision' => 50, 'paid_amount' => 999,
            'tenant_id' => $other->tenant_id, 'store_id' => $other->id, 'customer_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'created_via' => 'dashboard',
            'channel' => 'whatsapp', 'tags' => ['x'], 'coupon_id' => 'x', 'subtotal_amount' => 1, 'confirmation_token_hash' => str_repeat('a', 64)];
        $cart = $this->cartWith($store, $variant);
        $o = $this->checkout($store, $cart, $probe + $this->checkoutBody(8000))->assertCreated()->json('data.order');
        $this->assertSame(['SH-1001', 'pending', 8000, 8000], [$o['number'], $o['status'], $o['total_amount'], $o['due_amount']]);
        $this->tenancy()->run($tenant, function () use ($store) {
            $order = Order::query()->firstOrFail();
            $this->assertSame([$store->id, 'website', 'storefront', 'unpaid', 0, 1], [$order->store_id, $order->channel, $order->created_via, $order->payment_status, $order->paid_amount, $order->revision]);
            $this->assertNotSame(str_repeat('a', 64), $order->confirmation_token_hash);
            $this->assertNotSame('01jzzzzzzzzzzzzzzzzzzzzzzz', $order->customer_id);
        });

        $m = $this->manual($h, $store, ['status' => 'delivered', 'number' => 'X', 'paid_amount' => 5, 'unit_price_amount' => 1, 'total_amount' => 1, 'store_id' => $other->id] + $this->manualBody($variant))
            ->assertCreated()->json('data');
        $this->assertSame(['pending', 'SH-1002', 0, 14000], [$m['status'], $m['number'], $m['paid_amount'], $m['total_amount']]);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/orders/{$m['id']}", ['revision' => 1, 'status' => 'delivered', 'paid_amount' => 1, 'number' => 'X', 'shipping_amount' => 0, 'customer_id' => null])
            ->assertOk()->assertJsonPath('data.status', 'pending')->assertJsonPath('data.number', 'SH-1002')->assertJsonPath('data.shipping_amount', 13000);

        $c = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'SAFE', 'type' => 'fixed', 'amount' => 100, 'used_count' => 50, 'revision' => 9, 'store_id' => $other->id, 'created_by' => null])
            ->assertStatus(422)->json(); // revision is prohibited on create
        $c = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'SAFE', 'type' => 'fixed', 'amount' => 100, 'used_count' => 50, 'store_id' => $other->id])->assertCreated()->json('data');
        $this->assertSame([0, 1], [$c['stats']['used_count'], $c['revision']]);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/coupons/{$c['id']}", ['revision' => 1, 'used_count' => 7])->assertOk()->assertJsonPath('data.stats.used_count', 0);
        $this->assertSame($store->id, Coupon::withoutTenancy()->value('store_id'));
    }

    /** S4: replay returns the same order; different body → mismatch; missing key → 400; in-flight → in_use; stale lock taken over. */
    public function test_idempotent_checkout(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $cart = $this->cartWith($store, $variant);
        $key = (string) Str::uuid();
        $first = $this->checkout($store, $cart, $this->checkoutBody(8000), $key)->assertCreated();
        $this->assertNull($first->headers->get('Idempotent-Replayed'));
        $replay = $this->checkout($store, $cart, $this->checkoutBody(8000), $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true');
        $this->assertSame($first->json(), $replay->json());
        $this->assertSame(1, Order::withoutTenancy()->count());
        $this->checkout($store, $cart, $this->checkoutBody(8000, ['customer_note' => 'changed']), $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->sf($store, 'POST', '/checkout', $this->checkoutBody(8000), $cart)->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $this->checkout($store, $cart, $this->checkoutBody(8000), 'bad key!')->assertStatus(400);
        // the stored response is encrypted at rest (it carries the confirmation token)
        $raw = DB::table('idempotency_keys')->value('response_body');
        $this->assertStringNotContainsString($first->json('data.confirmation_token'), (string) $raw);

        // an in-flight request with the same key → 409 in_use; once its lock is stale it's taken over
        $cart2 = $this->cartWith($store, $variant);
        $key2 = (string) Str::uuid();
        $this->checkout($store, $cart2, $this->checkoutBody(8000), $key2)->assertCreated();
        $this->tenancy()->run($tenant, fn () => IdempotencyKey::query()->where('key', $key2)->update(['status' => 'processing', 'locked_until' => now()->addSeconds(20)]));
        $this->checkout($store, $cart2, $this->checkoutBody(8000), $key2)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_in_use');
        // a failed attempt frees the key for a retry with the same key
        $cart3 = $this->cartWith($store, $variant);
        $key3 = (string) Str::uuid();
        $this->checkout($store, $cart3, $this->checkoutBody(1), $key3)->assertStatus(409);
        $this->checkout($store, $cart3, $this->checkoutBody(1), $key3)->assertStatus(409)->assertJsonPath('error.code', 'checkout_changed');
        $this->assertSame(0, IdempotencyKey::withoutTenancy()->where('key', $key3)->count());
        // keys expire after 24 h
        $this->travel(25)->hours();
        $this->artisan('idempotency:prune')->assertSuccessful();
        $this->assertSame(0, IdempotencyKey::withoutTenancy()->where('key', $key)->count());
    }

    /** S5 + S15: tokens and PII never reach the logs; the DB holds only the token hash. */
    public function test_tokens_and_pii_never_logged(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $cart = $this->cartWith($store, $variant);
        $order = $this->checkout($store, $cart, $this->checkoutBody(8000, ['contact' => ['email' => 'secret@example.com']]))->assertCreated()->json('data');
        $id = Order::withoutTenancy()->value('id');
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/orders/{$id}", ['revision' => 1, 'contact' => ['phone' => '01999888777'],
            'shipping_address' => ['district_code' => 'dhaka', 'thana_code' => 'dhaka-gulshan', 'address_line' => 'Secret Lane 99']])->assertOk()
            ->assertJsonPath('data.events.0.meta', ['fields' => ['contact.phone', 'shipping_address']]);
        $this->assertFalse(DB::table('carts')->where('token_hash', $cart)->exists());
        $blob = implode("\n", $logged);
        foreach ([$cart, $order['confirmation_token'], '8801711000001', '01711000001', '01999888777', 'House 12', 'Secret Lane', 'secret@example.com'] as $needle) {
            $this->assertStringNotContainsString($needle, $blob);
        }
        $events = json_encode(OrderEvent::withoutTenancy()->get()->toArray());
        $this->assertStringNotContainsString('Secret Lane', $events);
        $this->assertStringNotContainsString('01999888777', $events);
    }

    /** S8: tracking needs number AND phone; mismatches look exactly like unknown numbers; throttled. */
    public function test_order_tracking_enumeration(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $number = $this->placeOrder($store, $variant)->json('data.order.number');
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.7'];
        $ok = $this->sf($store, 'POST', '/orders/track', ['number' => strtolower($number), 'phone' => '+8801711000001'], null, $ip)->assertOk()
            ->assertJsonPath('data.shipping', ['district' => 'Dhaka', 'thana' => 'Dhanmondi'])->assertJsonPath('data.timeline.0.status', 'pending');
        $this->assertStringNotContainsString('rafi', strtolower((string) $ok->getContent()));
        $this->sf($store, 'POST', '/orders/track', ['number' => '1001', 'phone' => '01711000001'], null, $ip)->assertOk();
        $wrongPhone = $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000002'], null, $ip)->assertNotFound();
        $unknown = $this->sf($store, 'POST', '/orders/track', ['number' => 'SH-9999', 'phone' => '01711000001'], null, $ip)->assertNotFound();
        $this->assertSame($unknown->getContent(), $wrongPhone->getContent());
        $this->sf($store, 'POST', '/orders/track', ['number' => 'XX-1001', 'phone' => '01711000001'], null, $ip)->assertNotFound();
        for ($i = 0; $i < 5; $i++) {
            $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000001'], null, $ip);
        }
        $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000001'], null, $ip)->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000001'], null, ['X-Storefront-Client-Ip' => '198.51.100.8'])->assertOk();
    }

    /** S9: checkout limiter per IP (10/min) and per phone (5 per 10 min). */
    public function test_checkout_spam_limits(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 500);
        $cart = $this->cartWith($store, $variant);
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.20'];
        for ($i = 0; $i < 10; $i++) {
            $this->checkout($store, $cart, $this->checkoutBody(1, ['contact' => ['phone' => sprintf('0171100%04d', $i)]]), null, $ip)->assertStatus(409);
        }
        $this->checkout($store, $cart, $this->checkoutBody(1, ['contact' => ['phone' => '01711009999']]), null, $ip)->assertStatus(429);

        for ($i = 0; $i < 5; $i++) {
            $this->checkout($store, $cart, $this->checkoutBody(1, ['contact' => ['phone' => '01811000000']]), null, ['X-Storefront-Client-Ip' => "198.51.100.{$i}"])->assertStatus(409);
        }
        $this->checkout($store, $cart, $this->checkoutBody(1, ['contact' => ['phone' => '+8801811000000']]), null, ['X-Storefront-Client-Ip' => '198.51.100.99'])->assertStatus(429);
        // an untrusted client-IP header (no valid key) cannot dodge the per-IP limit — the request is refused anyway
        $this->flushHeaders()->withHeaders(['X-Storefront-Key' => 'wrong', 'X-Storefront-Host' => $this->host($store), 'X-Storefront-Client-Ip' => '1.2.3.4'])
            ->postJson('/api/v1/storefront/checkout', [])->assertStatus(401);
    }

    /** Append-only order timeline; committed stock written only by InventoryService. */
    public function test_order_events_are_append_only_and_committed_has_one_writer(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $this->manual($h, $store, $this->manualBody($variant))->assertCreated();
        $this->tenancy()->run($tenant, function () {
            $event = OrderEvent::query()->firstOrFail();
            try {
                $event->forceFill(['body' => 'x'])->save();
                $this->fail('update allowed');
            } catch (LogicException) {
            }
            $this->expectException(LogicException::class);
            $event->delete();
        });
    }

    public function test_only_inventory_service_writes_committed(): void
    {
        $offenders = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(app_path()));
        foreach ($it as $file) {
            if (! $file->isFile() || $file->getExtension() !== 'php' || str_ends_with($file->getPathname(), 'Inventory/InventoryService.php')) {
                continue;
            }
            $code = (string) file_get_contents($file->getPathname());
            if (preg_match('/->committed\s*(=[^=>]|\+\+|--|\+=|-=)/', $code)
                || preg_match('/(increment|decrement)\(\s*[\'"]committed/', $code)
                || preg_match('/update\(\s*\[[^\]]*[\'"]committed[\'"]\s*=>/s', $code)) {
                $offenders[] = str_replace(app_path(), 'app', $file->getPathname());
            }
        }
        $this->assertSame([], $offenders);
    }

    // ---------------- Postgres race tests (CI `perf` / `security (postgres)` jobs) ----------------

    /** S2: stock 5, 20 parallel checkouts of 1 → exactly 5 orders, committed = 5, 15 × out_of_stock. */
    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_checkouts_never_oversell(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, $tenant, $store, $h] = $this->liveShop();
            [, $variant] = $this->stocked($h, $store, 1000, 5);
            $carts = [];
            for ($i = 0; $i < 20; $i++) {
                $carts[] = $this->cartWith($store, $variant);
            }
            $results = $this->parallel(20, fn (int $i) => $this->checkout($store, $carts[$i], $this->checkoutBody(8000, ['contact' => ['phone' => sprintf('0171200%04d', $i)]]))->status());
            $this->assertSame(5, count(array_filter($results, fn ($s) => $s === 201)), json_encode($results));
            $this->assertSame(15, count(array_filter($results, fn ($s) => $s === 422)), json_encode($results));
            $this->assertSame(5, Order::withoutTenancy()->where('store_id', $store->id)->count());
            $this->assertSame(5, Inventory::withoutTenancy()->where('variant_id', $variant)->value('committed'));
        } finally {
            $this->raceCleanup();
        }
    }

    /** S2: carts A+B and B+A in parallel never deadlock (fixed lock order). */
    #[Group('perf')]
    #[Group('race')]
    public function test_mixed_carts_do_not_deadlock(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, , $store, $h] = $this->liveShop();
            [, $a] = $this->stocked($h, $store, 1000, 1000);
            [, $b] = $this->stocked($h, $store, 1000, 1000);
            $carts = [];
            for ($i = 0; $i < 40; $i++) {
                [$first, $second] = $i % 2 === 0 ? [$a, $b] : [$b, $a];
                $carts[] = $this->cartWith($store, $second, 1, $this->cartWith($store, $first));
            }
            $results = $this->parallel(40, fn (int $i) => $this->checkout($store, $carts[$i], $this->checkoutBody(9000, ['contact' => ['phone' => sprintf('0171300%04d', $i)]]))->status());
            $this->assertSame(array_fill(0, 40, 201), $results);
        } finally {
            $this->raceCleanup();
        }
    }

    /** S3: usage_limit 3, 10 parallel checkouts with the coupon → 3 redemptions, used_count 3. */
    #[Group('perf')]
    #[Group('race')]
    public function test_coupon_usage_limit_holds_under_parallel_checkouts(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, , $store, $h] = $this->liveShop();
            [, $variant] = $this->stocked($h, $store, 10000, 100);
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'THREE', 'type' => 'fixed', 'amount' => 1000, 'status' => 'active', 'usage_limit' => 3])->assertCreated();
            $carts = [];
            for ($i = 0; $i < 10; $i++) {
                $carts[] = $token = $this->cartWith($store, $variant);
                $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'THREE'], $token)->assertOk();
            }
            $results = $this->parallel(10, fn (int $i) => $this->checkout($store, $carts[$i], $this->checkoutBody(16000, ['contact' => ['phone' => sprintf('0171400%04d', $i)]]))->status());
            $this->assertSame(3, count(array_filter($results, fn ($s) => $s === 201)), json_encode($results));
            $this->assertSame(3, Coupon::withoutTenancy()->where('code', 'THREE')->value('used_count'));
            $this->assertSame(3, DB::table('coupon_redemptions')->where('status', 'active')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    /** S4: two concurrent requests with one key → one order; the other is 409 in_use or the replay. */
    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_same_key_creates_one_order(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, , $store, $h] = $this->liveShop();
            [, $variant] = $this->stocked($h, $store, 1000, 100);
            $cart = $this->cartWith($store, $variant);
            $key = (string) Str::uuid();
            $results = $this->parallel(2, fn () => $this->checkout($store, $cart, $this->checkoutBody(8000), $key)->status());
            sort($results);
            $this->assertContains($results, [[201, 201], [201, 409]]);
            $this->assertSame(1, Order::withoutTenancy()->where('store_id', $store->id)->count());
        } finally {
            $this->raceCleanup();
        }
    }

    /** S17: parallel manual orders at limit − 1 → one 201, one 402. */
    #[Group('perf')]
    #[Group('race')]
    public function test_manual_order_plan_limit_race(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            $this->seed(PlanSeeder::class);
            [, $tenant, $store, $h] = $this->liveShop();
            [, $variant] = $this->stocked($h, $store, 1000, 0, ['track_inventory' => false]);
            $this->tenancy()->run($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]));
            FeatureGate::forget($tenant->id);
            $first = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data.id');
            $this->tenancy()->run($tenant, function () use ($first) {
                $order = Order::query()->findOrFail($first);
                for ($i = 0; $i < 48; $i++) {
                    $copy = $order->replicate(['number', 'sequence', 'idempotency_key']);
                    $copy->number = 'X-'.$i;
                    $copy->sequence = 9000 + $i;
                    $copy->save();
                }
            });
            $results = $this->parallel(2, fn () => $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->status());
            sort($results);
            $this->assertSame([201, 402], $results);
        } finally {
            $this->raceCleanup();
        }
    }
}
