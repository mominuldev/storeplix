<?php

namespace Tests\Feature\Commerce;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Mail\NewOrderMerchantMail;
use App\Domain\Orders\Mail\OrderPlacedMail;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Notifications\SendOrderMail;
use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §8 notifications (P5-26), S13, S18. The queue is `sync` in tests, so jobs run after commit. */
class NotificationsTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    private function sms(): array
    {
        return app(SmsGateway::class)->sent;
    }

    public function test_order_placed_sms_is_bangla_by_default_and_logged_without_body(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 120000, 5);
        $this->placeOrder($store, $variant, 1, ['contact' => ['email' => 'rafi@example.com']]);

        $this->assertCount(1, $this->sms());
        $text = $this->sms()[0]['text'];
        $this->assertSame('8801711000001', $this->sms()[0]['to']);
        $this->assertStringContainsString('প্রিয় Rafi, Shop', $text);
        $this->assertStringContainsString('SH-1001', $text);
        $this->assertStringContainsString('মোট 1,270 টাকা', $text);
        $this->assertStringContainsString('https://'.$this->host($store).'/track', $text);
        $message = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->firstOrFail();
        $this->assertSame(['order_placed', 'order_placed.bn', 'sent', $tenant->id], [$message->purpose, $message->template, $message->status, $message->tenant_id]);
        $this->tenancy()->run($tenant, function () {
            $event = OrderEvent::query()->where('type', 'notification')->firstOrFail();
            $this->assertSame(['sms', 'order_placed', 'sent'], [$event->meta['channel'], $event->meta['event'], $event->meta['status']]);
        });
        Mail::assertSent(OrderPlacedMail::class, fn (OrderPlacedMail $m) => $m->hasTo('rafi@example.com') && $m->hasReplyTo('shop@example.test') && $m->hasFrom('orders@storeplix.test'));
        Mail::assertSent(NewOrderMerchantMail::class, fn ($m) => $m->hasTo('shop@example.test'));
    }

    public function test_toggles_language_and_overrides(): void
    {
        Mail::fake();
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['notifications' => ['sms_language' => 'en', 'new_order_email' => false, 'customer_sms' => ['order_placed' => false]]])->assertOk()
            ->assertJsonPath('data.commerce.notifications.sms_language', 'en')
            ->assertJsonPath('data.commerce.notifications.customer_sms', ['order_placed' => false, 'order_confirmed' => false, 'order_shipped' => true, 'order_cancelled' => true]);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        $this->assertCount(0, $this->sms());
        Mail::assertNotSent(NewOrderMerchantMail::class);

        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/confirm")->assertOk(); // confirmed toggle off
        $this->assertCount(0, $this->sms());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/ship", ['carrier_name' => 'Pathao'])->assertOk();
        $this->assertCount(1, $this->sms());
        $this->assertStringStartsWith('Shop', $this->sms()[0]['text']);
        $this->assertStringContainsString('is on its way with Pathao. Keep Tk 140 ready.', $this->sms()[0]['text']);

        $other = $this->manual($h, $store, $this->manualBody($variant))->json('data.id'); // notify_customer defaults to true
        $this->assertCount(2, $this->sms());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$other}/confirm", ['notify_customer' => true])->assertOk();
        $this->assertCount(3, $this->sms());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$other}/cancel", ['reason' => 'other', 'notify_customer' => false])->assertOk();
        $this->assertCount(3, $this->sms());
    }

    public function test_monthly_allowance_skips_sms_with_a_timeline_note(): void
    {
        $this->seed(PlanSeeder::class);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $this->tenancy()->run($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]));
        FeatureGate::forget($tenant->id);
        $rows = array_map(fn () => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'to' => '8801700000000', 'purpose' => 'order_placed', 'template' => 'order_placed.bn', 'status' => 'sent', 'created_at' => now(), 'updated_at' => now()], range(1, 200));
        $this->platformQuery(SmsMessage::class)->insert($rows);
        $id = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->assertCount(0, $this->sms());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")
            ->assertJsonPath('data.events.0.body', 'SMS not sent: monthly SMS allowance used')->assertJsonPath('data.events.0.meta.status', 'skipped');
    }

    #[Group('security')]
    public function test_job_retry_sends_at_most_one_sms_per_event(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant))->json('data.id');
        $this->assertCount(1, $this->sms());
        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id));
        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id));
        $this->assertCount(1, $this->sms());
        $this->assertSame(1, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->count());
    }

    /** F-L3: a provider failure is not recorded as sent and is retried; the retry sends exactly once. */
    #[Group('security')]
    public function test_failed_send_is_retried_without_duplicates(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        $gateway = app(SmsGateway::class);
        $gateway->failNext = true;
        try {
            dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id));
            $this->fail('the failed send must throw so the queue retries it');
        } catch (SmsSendFailed) {
        }
        $this->assertCount(0, $this->sms());
        $this->assertSame('failed', $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->value('status'));
        $this->tenancy()->run($tenant, fn () => $this->assertSame(0, OrderEvent::query()->where('type', 'notification')->count()));

        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id)); // the retry
        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id)); // a late duplicate
        $this->assertCount(1, $this->sms());
        $this->tenancy()->run($tenant, function () {
            $events = OrderEvent::query()->where('type', 'notification')->get();
            $this->assertCount(1, $events);
            $this->assertSame(['sent', 'SMS sent: Order received'], [$events[0]->meta['status'], $events[0]->body]);
        });
        $this->assertSame(1, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('status', 'sent')->count());
    }

    /** F-L3: after the last try the timeline says the SMS was not sent (and nothing throws). */
    public function test_last_failed_try_is_recorded_as_not_sent(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        app(SmsGateway::class)->failNext = true;
        $job = new class($id, 'order_placed') extends SendOrderSms
        {
            public function attempts(): int
            {
                return $this->tries;
            }
        };
        $this->tenancy()->run($tenant, fn () => app()->call([$job, 'handle']));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")
            ->assertJsonPath('data.events.0.body', 'SMS not sent: the SMS provider failed')->assertJsonPath('data.events.0.meta.status', 'failed');
        $this->assertCount(0, $this->sms());
    }

    /** F-L3: a delayed "order received" SMS is not sent once the order is cancelled; the cancel SMS still is. */
    public function test_late_sms_for_a_cancelled_order_is_skipped(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/cancel", ['reason' => 'duplicate'])->assertOk();
        $this->assertCount(1, $this->sms()); // order_cancelled (toggle on)
        dispatch((new SendOrderSms($id, 'order_placed'))->forTenant($tenant->id));
        dispatch((new SendOrderSms($id, 'order_confirmed'))->forTenant($tenant->id));
        $this->assertCount(1, $this->sms());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")
            ->assertJsonPath('data.events.0.body', 'SMS not sent: the order was cancelled')->assertJsonPath('data.events.0.meta.status', 'skipped');
    }

    /** S13: shopper-controlled text is one line, link-free and truncated. */
    #[Group('security')]
    public function test_sms_variables_are_sanitised(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $this->tenancy()->run($tenant, fn () => Store::query()->update(['name' => "Shop\nhttps://evil.example/x Deals ".str_repeat('x', 60)]));
        $this->manual($h, $store, $this->manualBody($variant, 1, ['contact' => ['name' => 'Rafi www.phish.example']]))->assertCreated();
        $text = $this->sms()[0]['text'];
        $this->assertStringNotContainsString("\n", $text);
        $this->assertStringNotContainsString('evil.example', $text);
        $this->assertStringNotContainsString('phish', $text);
        $this->assertStringContainsString(mb_substr('Shop Deals '.str_repeat('x', 60), 0, 40), $text);
    }

    public function test_every_template_fits_three_ucs2_segments(): void
    {
        // A 40-character shop name with a typical host renders untouched.
        $typical = ['first_name' => 'Farhana', 'shop' => str_repeat('S', 40), 'number' => 'GS-1042', 'total' => '12,500',
            'due' => '12,500', 'carrier' => 'Steadfast', 'track_url' => 'https://gallery.storeplix.com/track'];
        // Worst case: long buyer name, long carrier, long host, big amounts.
        $extreme = ['first_name' => str_repeat('ন', 20), 'shop' => str_repeat('S', 40), 'number' => 'ABCDEF-1234567', 'total' => '1,000,000',
            'due' => '1,000,000', 'carrier' => str_repeat('C', 30), 'track_url' => 'https://'.str_repeat('a', 40).'.storeplix.com/track'];
        foreach (['bn', 'en'] as $language) {
            foreach (SmsTemplates::EVENTS as $event) {
                $text = SmsTemplates::render($event, $language, $typical);
                $this->assertLessThanOrEqual(201, mb_strlen($text), "{$language}.{$event}: ".mb_strlen($text));
                $this->assertStringContainsString(str_repeat('S', 40), $text);
                $worst = SmsTemplates::render($event, $language, $extreme);
                $this->assertLessThanOrEqual(201, mb_strlen($worst), "{$language}.{$event} (extreme): ".mb_strlen($worst));
                $this->assertStringNotContainsString('{', $worst);
                if (str_contains($worst, 'https://')) {
                    $this->assertStringContainsString($extreme['track_url'], $worst);
                }
            }
        }
    }

    public function test_merchant_email_falls_back_to_a_verified_owner(): void
    {
        [$owner, $tenant, $store] = $this->liveShop();
        $settings = fn () => StoreSetting::query()->where('store_id', $store->id)->first();
        $this->tenancy()->run($tenant, function () use ($store, $settings, $owner) {
            $this->assertSame('shop@example.test', SendOrderMail::merchantRecipient($store, $settings()));
            StoreSetting::query()->update(['contact_email' => null]);
            User::query()->whereKey($owner->id)->update(['email_verified_at' => now()]);
            $this->assertSame($owner->email, SendOrderMail::merchantRecipient($store, $settings()));
            User::query()->whereKey($owner->id)->update(['email_verified_at' => null]);
            $this->assertNull(SendOrderMail::merchantRecipient($store, $settings()));
        });
    }

    /** S18: a job naming another tenant's order finds nothing and sends nothing. */
    #[Group('tenancy')]
    public function test_notification_job_is_tenant_isolated(): void
    {
        [, $tenantA] = $this->liveShop('alpha');
        [, , $storeB, $hB] = $this->liveShop('bravo');
        [, $variant] = $this->stocked($hB, $storeB, 1000, 5);
        $this->manual($hB, $storeB, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated();
        $orderB = Order::withoutTenancy()->firstOrFail();
        dispatch((new SendOrderSms($orderB->id, 'order_confirmed'))->forTenant($tenantA->id));
        dispatch((new SendOrderMail($orderB->id, SendOrderMail::MERCHANT_NEW))->forTenant($tenantA->id));
        $this->assertCount(0, $this->sms());
        $this->assertSame(0, OrderEvent::withoutTenancy()->where('type', 'notification')->count());
    }
}
