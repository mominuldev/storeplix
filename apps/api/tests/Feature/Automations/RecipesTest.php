<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Automations\Engine\AutomationEngine;
use App\Domain\Automations\Jobs\EvaluateAutomation;
use App\Domain\Automations\Mail\LowStockMail;
use App\Domain\Billing\Models\Plan;
use App\Domain\Customers\Models\Customer;
use App\Domain\Orders\Models\Order;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-6 §3–§6 recipes end to end on the fake SMS gateway (trigger → run → steps → outcomes): thank-you (wait,
 * quiet hours, conditions matrix, eligibility S128), VIP tag (n deliveries, once per customer), return flag, low stock
 * team email (S138), dedupe of a duplicated event (S129), not-in-plan (no run).
 */
#[Group('automations')]
class RecipesTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_thank_you_on_delivery_sends_one_sms_and_logs_the_run(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $a = $this->automationOn($h, $store, 'thank_you', ['message' => ['language' => 'en', 'body' => 'Thanks {name} for {order_no}! {shop_link}']]);
        $order = $this->deliveredOrder($h, $store, $variant);

        $runs = $this->runsOf($tenant, $a['id']);
        $this->assertCount(1, $runs);
        $run = $runs[0];
        $this->assertSame(['completed', null, 'order', $order['id'], 'order:'.$order['id']], [$run->status, $run->outcome_reason, $run->subject_type, $run->subject_id, $run->dedupe_key]);
        $steps = $this->stepsOf($tenant, $run->id);
        $this->assertCount(1, $steps);
        $this->assertSame(['send_message', 'done', 'sms', '8801811223344', 1], [$steps[0]->action, $steps[0]->status, $steps[0]->channel, $steps[0]->address, $steps[0]->parts]);
        $this->assertNotNull($steps[0]->unsubscribe_code_hash);
        $sent = $this->sms()->sent;
        $this->assertCount(1, $sent);
        $this->assertStringContainsString("Thanks Nusrat for {$order['number']}! {$store->slug}.storeplix.test", $sent[0]['text']);
        $this->assertMatchesRegularExpression('~\nSTOP: '.preg_quote($store->slug, '~').'\.storeplix\.test/u/[A-Za-z0-9]{10}$~', $sent[0]['text']);
        $this->assertSame(1, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'automation')->count());
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'customer.%')->count(), 'per-action changes only in the run log');

        $r = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs")->assertOk()->json('data.0');
        $this->assertSame(['type' => 'order', 'id' => $order['id'], 'label' => $order['number']], $r['subject']);
        $this->assertSame(['id' => $a['id'], 'recipe' => 'thank_you', 'name' => 'Thank-you message'], $r['automation']);
        $this->assertSame('+880 18•• •••344', $r['steps'][0]['masked_address']);
        $this->assertSame(['index', 'action', 'status', 'reason', 'channel', 'masked_address', 'parts', 'detail', 'executed_at'], array_keys($r['steps'][0]));
        $this->assertSame($order['number'], $r['context']['order_number']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs/{$run->id}")->assertOk()->assertJsonPath('data.id', $run->id);
        $this->api($h, 'GET', $this->aUrl($store))->assertJsonPath('data.0.runs_7d', 1)->assertJsonPath('meta.kpis.messages_sent_month', 1)
            ->assertJsonPath('meta.kpis.runs_7d_succeeded_pct', 100);
    }

    public function test_wait_and_quiet_hours_defer_the_message_to_resume_due(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'thank_you', ['delay_hours' => 10]);
        Carbon::setTestNow(Carbon::parse('2026-11-24 06:00:00', 'UTC')); // 12:00 Dhaka
        $this->deliveredOrder($h, $store, $variant);
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['waiting', 1], [$run->status, $run->next_step]);
        $this->assertSame('2026-11-24T16:00:00Z', $run->resume_at->toIso8601ZuluString());

        $this->resumeDue();
        $this->assertSame('waiting', $this->runsOf($tenant)->first()->status, 'not due yet');
        Carbon::setTestNow(Carbon::parse('2026-11-24 16:00:00', 'UTC')); // 22:00 Dhaka: quiet hours (S134)
        $this->resumeDue();
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['waiting', '2026-11-25T03:00:00Z'], [$run->status, $run->resume_at->toIso8601ZuluString()]);
        $this->assertCount(0, $this->sms()->sent);
        $this->resumeDue(); // twice: still nothing (S129)
        Carbon::setTestNow(Carbon::parse('2026-11-25 03:00:00', 'UTC')); // 09:00 Dhaka
        $this->resumeDue();
        $this->resumeDue();
        $this->assertSame('completed', $this->runsOf($tenant)->first()->status);
        $this->assertCount(1, $this->sms()->sent);
    }

    public function test_conditions_matrix_and_eligibility(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000);
        $a = $this->automationOn($h, $store, 'thank_you', ['conditions' => [
            ['field' => 'order.total_amount', 'op' => 'gt', 'value' => 150000],
            ['field' => 'order.payment_method', 'op' => 'is', 'value' => 'cod'],
            ['field' => 'order.channel', 'op' => 'in', 'value' => ['facebook']],
            ['field' => 'customer.tag', 'op' => 'not_has', 'value' => 'no-sms'],
        ]]);
        $this->deliveredOrder($h, $store, $variant); // 1,000 + delivery < 1,500 → fails total
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['skipped', 'conditions_not_met'], [$run->status, $run->outcome_reason]);
        $this->assertSame([false, true, true, true], array_column($run->outcome_detail['conditions'], 'passed'));
        $this->assertCount(0, $this->stepsOf($tenant, $run->id));
        // The run log names the failing condition (QA P86-QA-2): only field/label/passed/detail leave the API.
        $shown = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs/{$run->id}")->assertOk()->json('data.outcome_detail');
        $this->assertSame(['conditions'], array_keys($shown));
        $this->assertSame(['order.total_amount', false], [$shown['conditions'][0]['field'], $shown['conditions'][0]['passed']]);
        $this->assertSame(['field', 'label', 'passed', 'detail'], array_keys($shown['conditions'][0]));

        // Passing order, but the customer is tagged → skipped; untagged → sent.
        $this->deliveredOrder($h, $store, $variant, ['items' => [['variant_id' => $variant, 'quantity' => 2]], 'contact' => ['name' => 'Tagged Buyer', 'phone' => '01822000111']]);
        $tagged = $this->inTenant($tenant, fn () => Customer::query()->where('phone', '8801822000111')->firstOrFail());
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/customers/{$tagged->id}", ['tags' => ['NO-SMS'], 'revision' => $tagged->revision])->assertOk();
        $this->deliveredOrder($h, $store, $variant, ['items' => [['variant_id' => $variant, 'quantity' => 2]], 'contact' => ['name' => 'Tagged Buyer', 'phone' => '01822000111']]);
        $this->deliveredOrder($h, $store, $variant, ['items' => [['variant_id' => $variant, 'quantity' => 2]], 'contact' => ['name' => 'Plain Buyer', 'phone' => '01822000222'], 'channel' => 'instagram']);
        $statuses = $this->runsOf($tenant, $a['id'])->map(fn ($r) => [$r->status, $r->outcome_reason])->all();
        $this->assertSame([['skipped', 'conditions_not_met'], ['completed', null], ['skipped', 'conditions_not_met'], ['skipped', 'conditions_not_met']], $statuses);
        $this->assertCount(1, $this->sms()->sent);
    }

    public function test_s128_customer_without_consent_and_orders_is_not_eligible(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'thank_you');
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data');
        $this->inTenant($tenant, fn () => Customer::query()->whereKey($order['customer']['id'] ?? Order::query()->whereKey($order['id'])->value('customer_id'))
            ->update(['orders_count' => 0, 'accepts_marketing' => false]));
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false])->assertOk();
        }
        $run = $this->runsOf($tenant)->first();
        $this->assertSame(['skipped', 'no_eligible_address'], [$run->status, $run->outcome_reason]);
        $this->assertSame(['skipped', 'not_eligible'], [$this->stepsOf($tenant, $run->id)[0]->status, $this->stepsOf($tenant, $run->id)[0]->reason]);
        $this->assertCount(0, $this->sms()->sent);
    }

    public function test_vip_tag_after_n_deliveries_once_per_customer(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 50);
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'VIP10', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active'])->assertCreated()->json('data.id');
        $a = $this->automationOn($h, $store, 'vip_tag', ['min_delivered' => 2, 'coupon_id' => $coupon, 'message' => ['language' => 'en', 'body' => 'You are VIP {name}! Code {coupon}']]);

        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        $runs = $this->runsOf($tenant, $a['id']);
        $this->assertSame([['skipped', 'conditions_not_met'], ['completed', null], ['skipped', 'conditions_not_met']], $runs->map(fn ($r) => [$r->status, $r->outcome_reason])->all());
        $customer = $this->inTenant($tenant, fn () => Customer::query()->where('phone', '8801811223344')->firstOrFail());
        $this->assertSame(['vip'], $customer->tags);
        $this->assertSame('customer:'.$customer->id, $runs[1]->dedupe_key);
        $steps = $this->stepsOf($tenant, $runs[1]->id);
        $this->assertSame([['add_tag', 'done', ['tag' => 'vip']], ['send_message', 'done', ['coupon_code' => 'VIP10']]], $steps->map(fn ($s) => [$s->action, $s->status, $s->detail])->all());
        $this->assertCount(1, $this->sms()->sent);
        $this->assertStringContainsString('You are VIP Nusrat! Code VIP10', $this->sms()->sent[0]['text']);
    }

    public function test_return_flag_tags_the_buyer(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $a = $this->automationOn($h, $store, 'return_flag');
        $order = $this->deliveredOrder($h, $store, $variant);
        $return = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'return', 'reason' => 'wrong_size',
            'lines' => [['order_item_id' => $order['items'][0]['id'], 'quantity' => 1]]])->assertCreated()->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/approve", [])->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/receive", ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true],
            'lines' => [['return_item_id' => $return['items'][0]['id'], 'restock_quantity' => 1]]])->assertOk();
        $run = $this->runsOf($tenant, $a['id'])->first();
        $this->assertSame(['completed', 'return', 'return:'.$return['id']], [$run->status, $run->subject_type, $run->dedupe_key]);
        $this->assertSame([['add_tag', 'done', 'returned']], $this->stepsOf($tenant, $run->id)->map(fn ($s) => [$s->action, $s->status, $s->detail['tag']])->all());
        $this->assertContains('returned', $this->inTenant($tenant, fn () => Customer::query()->where('phone', '8801811223344')->firstOrFail())->tags);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs/{$run->id}")->assertJsonPath('data.subject.label', $return['number']);
    }

    public function test_s138_low_stock_emails_current_team_members_with_the_permission(): void
    {
        Mail::fake();
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        [$staff] = $this->member($tenant, TenantUser::ROLE_STAFF); // staff: inventory.adjust per SystemRole?
        [$admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $a = $this->automationOn($h, $store, 'low_stock');
        $adjust = fn (int $qty) => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments",
            ['reason' => 'lost', 'items' => [['variant_id' => $variant, 'mode' => 'set', 'quantity' => $qty]]])->assertOk();

        $adjust(4);
        $run = $this->runsOf($tenant, $a['id'])->first();
        $this->assertSame('completed', $run->status);
        $expected = [$owner->email, $admin->email];
        $staffAllowed = $this->inTenant($tenant, fn () => SystemRole::from('staff')->permissions()->has(Permission::InventoryAdjust));
        if ($staffAllowed) {
            $expected[] = $staff->email;
        }
        $this->assertSame(['recipients' => count($expected)], $this->stepsOf($tenant, $run->id)[0]->detail);
        Mail::assertQueued(LowStockMail::class, count($expected));
        Mail::assertQueued(LowStockMail::class, fn (LowStockMail $m) => str_contains($m->envelope()->subject, 'Low stock:') && str_contains($m->envelope()->subject, '— 4 left'));
        foreach ($expected as $email) {
            Mail::assertQueued(LowStockMail::class, fn (LowStockMail $m) => $m->hasTo($email));
        }

        // A removed member stops receiving (next day: new dedupe key).
        $this->inTenant($tenant, fn () => TenantUser::query()->where('tenant_id', $tenant->id)->where('user_id', $admin->id)->delete());
        Carbon::setTestNow(now()->addDay());
        $adjust(10);
        $adjust(3);
        $runs = $this->runsOf($tenant, $a['id']);
        $this->assertCount(2, $runs);
        $this->assertSame(count($expected) - 1, $this->stepsOf($tenant, $runs[1]->id)[0]->detail['recipients']);
        Mail::assertNotQueued(LowStockMail::class, fn (LowStockMail $m) => $m->hasTo($admin->email) && str_contains($m->envelope()->subject, '3 left'));
    }

    public function test_s129_duplicate_event_and_not_in_plan_create_no_second_run(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $a = $this->automationOn($h, $store, 'thank_you');
        $order = $this->deliveredOrder($h, $store, $variant);
        $engine = app(AutomationEngine::class);
        $this->inTenant($tenant, function () use ($engine, $a, $order) {
            $this->assertNull($engine->start($a['id'], 'order.delivered', 'order', $order['id']));
            dispatch(new EvaluateAutomation($a['id'], 'order.delivered', 'order', $order['id']));
        });
        $this->assertCount(1, $this->runsOf($tenant));
        $this->assertCount(1, $this->sms()->sent);

        $this->planFor($tenant, Plan::FREE);
        $this->deliveredOrder($h, $store, $variant);
        $this->assertCount(1, $this->runsOf($tenant), 'not in plan → no run');
    }
}
