<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Sending\HostResolver;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Developer\Webhooks\FakeHostResolver;
use Tests\TestCase;

/**
 * PHASE-8-8D: InventoryService::sell (P88D-6, S199) called directly, outbound webhooks for till sales (P88D-13) and the
 * SMS receipt allowance (P88D-12, S204).
 */
#[Group('pos')]
class PosIntegrationTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_sell_locks_in_variant_location_order_writes_one_ledger_row_per_stock_row_and_is_all_or_nothing(): void
    {
        $s = $this->posShop(shopStock: 5, price: 1000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        [, $second] = $this->stocked($h, $store, price: 1000, stock: 0);
        $this->adjustAt($h, $store, [['variant_id' => $second, 'mode' => 'delta', 'quantity' => 2, 'location_id' => $s['shop']]])->assertOk();

        $orderB = strtolower((string) Str::ulid());
        $this->inTenant($tenant, function () use ($s, $store, $second, $orderB) {
            $service = app(InventoryService::class);
            // A shortage on one line changes nothing on the other.
            try {
                DB::transaction(fn () => $service->sell($store->id, $s['shop'], [
                    ['variant_id' => $s['variant'], 'quantity' => 1, 'field' => 'lines.0.quantity'],
                    ['variant_id' => $second, 'quantity' => 3, 'field' => 'lines.1.quantity'],
                ], strtolower((string) Str::ulid()), null));
                $this->fail('sold more than available');
            } catch (ApiException $e) {
                $this->assertSame(['out_of_stock', ['lines.1.quantity' => ['Only 2 left at Mirpur shop.']]], [$e->errorCode, $e->details]);
            }
            $this->assertSame(5, $this->onHand($s['tenant'], $s['variant'], $s['shop']));

            DB::enableQueryLog();
            $moves = DB::transaction(fn () => $service->sell($store->id, $s['shop'], [
                ['variant_id' => $second, 'quantity' => 1],
                ['variant_id' => $s['variant'], 'quantity' => 2],
                ['variant_id' => $s['variant'], 'quantity' => 1],
            ], $orderB, null));
            $lock = collect(DB::getQueryLog())->first(fn ($q) => str_contains($q['query'], 'from "inventories"'));
            DB::disableQueryLog();
            $this->assertStringContainsString('order by "variant_id" asc, "location_id" asc', (string) $lock['query']);
            $this->assertCount(2, $moves); // one per stock row (the same variant's lines are summed)
            foreach ($moves as $m) {
                $this->assertSame(['pos_sale', 'order', $orderB, $s['shop']], [$m->reason, $m->reference_type, $m->reference_id, $m->location_id]);
            }
            $this->assertSame([], $service->sell($store->id, $s['shop'], [], $orderB, null));
        });
        $this->assertSame(2, $this->onHand($tenant, $s['variant'], $s['shop']));
        $this->assertSame(1, $this->onHand($tenant, $second, $s['shop']));
        $this->assertSame(10, $this->onHand($tenant, $s['variant'], $s['main']));
        $this->assertNotContains('pos_sale', InventoryMovement::MANUAL_REASONS);
        $this->assertContains('pos_sale', InventoryMovement::REASONS);
    }

    public function test_till_sales_fire_order_created_and_order_paid_webhooks(): void
    {
        $this->app->instance(HostResolver::class, new FakeHostResolver(['hooks.example.com' => ['93.184.216.34']]));
        config(['webhooks_out.fake' => false, 'webhooks_out.allow_http' => false]);
        $s = $this->posShop(shopStock: 5, price: 10000);
        $this->api($s['h'], 'POST', "/api/v1/stores/{$s['store']->id}/webhook-endpoints", ['url' => 'https://hooks.example.com/pos', 'events' => ['order.created', 'order.paid']])->assertCreated();
        $session = $this->posSession($s);
        $sale = $this->cashSale($s, $session);

        foreach (['order.created', 'order.paid'] as $type) {
            $rows = $this->platformQuery(WebhookDelivery::class)->where('tenant_id', $s['tenant']->id)->where('event_type', $type)->get();
            $this->assertCount(1, $rows, $type);
            $object = $rows->first()->payload['data']['object'];
            $this->assertSame([$sale['order_id'], 'pos', 'walk_in', 'delivered', 'paid'], [$object['id'], $object['created_via'], $object['channel'], $object['status'], $object['payment_status']]);
        }
    }

    public function test_sms_receipt_respects_the_monthly_allowance(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        Plan::query()->where('code', Plan::GROWTH)->get()->each(function (Plan $p) {
            $p->limits = ['sms_per_month' => 1] + (array) $p->limits;
            $p->save();
        });
        FeatureGate::forget($tenant->id);
        $session = $this->posSession($s);

        $first = $this->cashSale($s, $session, 1, ['sms_receipt' => true, 'customer' => ['phone' => '01711552211', 'name' => 'Farhana']]);
        $this->assertSame('sent', $first['sms_receipt_status']);
        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$first['id']}/sms-receipt"))->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached');

        // The job re-checks: a ticked sale over the allowance is skipped on the timeline (status failed), nothing sent.
        $second = $this->cashSale($s, $session, 1, ['sms_receipt' => true, 'customer' => ['phone' => '01811223344', 'name' => 'Rafi']]);
        $this->assertSame('failed', $second['sms_receipt_status']);
        $this->assertCount(1, app(SmsGateway::class)->sent);
        $this->assertSame(1, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->count());
        $note = $this->platformQuery(OrderEvent::class)->where('order_id', $second['order_id'])->where('type', 'notification')->sole();
        $this->assertSame(['sms', 'pos_receipt', 'skipped'], [$note->meta['channel'], $note->meta['event'], $note->meta['status']]);
    }

    public function test_sms_receipt_text_is_sanitised(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['name' => "Deals\nhttps://phish.example/x Shop"]));
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/document-templates/receipt_80mm", ['config' => [
            'show_logo' => true, 'show_bin' => false, 'show_product_names' => true, 'show_prices' => true, 'show_sku' => false,
            'language' => 'en', 'footer_text' => 'Visit www.evil.example now',
        ]])->assertOk();
        $session = $this->posSession($s);
        $this->cashSale($s, $session, 1, ['sms_receipt' => true, 'customer' => ['phone' => '01711552211', 'name' => 'Farhana'], 'payments' => [['method' => 'card', 'amount' => 10000]], 'tendered_cash_amount' => null]);

        $sent = app(SmsGateway::class)->sent;
        $this->assertCount(1, $sent);
        $text = (string) ($sent[0]['text'] ?? $sent[0][1] ?? json_encode($sent[0]));
        $this->assertStringNotContainsString('phish', $text);
        $this->assertStringNotContainsString('www.', $text);
        $this->assertStringNotContainsString("\n", $text);
    }
}
