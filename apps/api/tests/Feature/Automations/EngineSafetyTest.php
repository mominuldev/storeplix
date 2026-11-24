<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Cart\Models\Cart;
use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-6 safety: dry run without side effects (S137), test message (P86-22, S135), the shared allowance (P86-8,
 * S135), reap-stuck / unknown never retried (S129), prune (P86-6), downgrade and disable stop waiting runs (P86-17),
 * the dev sink (S140), email escaping (S136).
 */
#[Group('automations')]
#[Group('security')]
class EngineSafetyTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase;

    private const TABLES = ['automation_runs', 'automation_run_steps', 'automation_conversions', 'sms_messages', 'audit_logs', 'carts', 'cart_items', 'customers', 'marketing_suppressions'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_s137_dry_run_has_no_side_effects(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'VIP10', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active'])->assertCreated()->json('data.id');
        $vip = $this->automationOn($h, $store, 'vip_tag', ['min_delivered' => 2, 'coupon_id' => $coupon, 'message' => ['language' => 'en', 'body' => 'VIP {name}: {coupon}']]);
        $recovery = $this->createAutomation($h, $store, 'checkout_recovery');
        $this->api($h, 'POST', $this->aUrl($store, "/{$recovery['id']}/dry-run"))->assertOk()->assertExactJson(['data' => ['subject' => null, 'conditions' => [], 'steps' => []]]);
        $this->planFor($tenant, Plan::FREE); // no runs from the deliveries below
        $order = $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        $this->planFor($tenant, Plan::STARTER);
        $cart = $this->contactCart($store, $variant, '01711000001', ['name' => 'Rafi']);
        $sent = count($this->sms()->sent);
        $before = $this->counts();

        $r = $this->api($h, 'POST', $this->aUrl($store, "/{$vip['id']}/dry-run"), ['order_id' => $order['id']])->assertOk()->json('data');
        $this->assertSame(['type' => 'order', 'id' => $order['id'], 'label' => $order['number']], $r['subject']);
        $this->assertSame([true, true], array_column($r['conditions'], 'passed'));
        $this->assertSame([['index' => 1, 'action' => 'add_tag', 'would' => 'tag', 'reason' => null, 'rendered' => null]], [$r['steps'][0]]);
        $this->assertSame(['send', 'sms', 1], [$r['steps'][1]['would'], $r['steps'][1]['rendered']['channel'], $r['steps'][1]['rendered']['parts']]);
        $this->assertStringContainsString('VIP Nusrat: VIP10', $r['steps'][1]['rendered']['text']);

        $c = $this->api($h, 'POST', $this->aUrl($store, "/{$recovery['id']}/dry-run"))->assertOk()->json('data');
        $this->assertSame('cart', $c['subject']['type']);
        $this->assertSame(['Customer is not risky'], array_column($c['conditions'], 'label'));
        $this->assertSame(['send', 'send'], array_column($c['steps'], 'would'));
        $this->assertStringContainsString('/r/Xxxxxxxxxx', $c['steps'][0]['rendered']['text']);

        $this->api($h, 'POST', $this->aUrl($store, "/{$vip['id']}/dry-run"), ['order_id' => $order['id'], 'cart_id' => $order['id']])->assertStatus(422);
        $this->api($h, 'POST', $this->aUrl($store, "/{$vip['id']}/dry-run"), ['cart_id' => $order['id']])->assertStatus(422);

        $this->assertSame($before, $this->counts(), 'zero writes');
        $this->assertCount($sent, $this->sms()->sent, 'zero provider calls');
        $this->assertSame(0, $this->inTenant($tenant, fn () => CampaignAllowance::used('sms')), 'zero allowance use');
        $this->assertNotNull($cart);
    }

    public function test_test_message_counts_toward_the_allowance_and_resolves_as_a_test_code(): void
    {
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        $a = $this->createAutomation($h, $store, 'checkout_recovery');
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"), ['step' => 1])->assertStatus(422);
        $owner->forceFill(['phone' => '8801911000111', 'phone_verified_at' => now()])->save();
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"))->assertStatus(202)->assertExactJson(['data' => ['to_masked' => '+880 19•• •••111']]);
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"), ['step' => 2])->assertStatus(202);
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"), ['step' => 3])->assertStatus(422);
        $this->assertCount(2, $this->sms()->sent);
        $parts = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'automation.test_sent')->get()->sum(fn ($r) => $r->meta['parts']);
        $this->assertSame($parts, $this->inTenant($tenant, fn () => CampaignAllowance::used('sms')));
        $code = $this->codeIn($this->sms()->sent[0]['text']);
        $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk()->assertJsonPath('data.is_test', true);

        $low = $this->createAutomation($h, $store, 'low_stock');
        $this->api($h, 'POST', $this->aUrl($store, "/{$low['id']}/test-message"))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        for ($i = 0; $i < 3; $i++) {
            $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"))->assertStatus(202);
        }
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"))->assertStatus(429);
    }

    public function test_s135_allowance_is_shared_with_campaigns(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        Plan::query()->where('code', Plan::STARTER)->get()->each(function (Plan $p) {
            $p->limits = ['campaign_sms_per_month' => 2] + (array) $p->limits;
            $p->save();
        });
        FeatureGate::forget($tenant->id);
        $this->automationOn($h, $store, 'thank_you', ['message' => ['language' => 'en', 'body' => 'Thanks {name}!']]); // 1 part each
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant, ['contact' => ['name' => 'Other Buyer', 'phone' => '01822000999']]);
        $this->deliveredOrder($h, $store, $variant, ['contact' => ['name' => 'Third Buyer', 'phone' => '01822000888']]);
        $steps = $this->platformQuery(AutomationRunStep::class)->where('tenant_id', $tenant->id)->orderBy('created_at')->orderBy('id')->get();
        $this->assertSame([['done', null], ['done', null], ['skipped', 'allowance']], $steps->map(fn ($s) => [$s->status, $s->reason])->all());
        $this->assertCount(2, $this->sms()->sent);
        $this->assertSame(2, $this->inTenant($tenant, fn () => CampaignAllowance::used('sms')));

        // Campaigns see the automation usage.
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached');
    }

    public function test_reap_stuck_marks_unknown_and_never_resends(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'checkout_recovery', ['step1' => ['message' => ['language' => 'en', 'body' => 'Hi {cart_link}']]]);
        $this->contactCart($store, $variant);
        $this->travel(31)->minutes();
        $this->detect();
        $run = $this->runsOf($tenant)->first();
        // Simulate a worker lost between the claim and the provider answer of step 1, and a run stuck `running`.
        $this->platformQuery(AutomationRunStep::class)->where('run_id', $run->id)->update(['status' => 'sending']);
        $this->platformQuery(AutomationRun::class)->whereKey($run->id)->update(['status' => 'running', 'next_step' => 0]);
        $this->travel(16)->minutes();
        $this->artisan('automations:reap-stuck')->assertSuccessful();
        $this->assertSame('unknown', $this->stepsOf($tenant, $run->id)[0]->status);
        $this->assertSame('waiting', $run->refresh()->status);
        $this->resumeDue();
        $this->assertCount(1, $this->sms()->sent, 'unknown is never retried');
        $this->assertSame(['waiting', 2], [$run->refresh()->status, $run->next_step]);
    }

    public function test_downgrade_and_disable_stop_waiting_runs_and_prune(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        $a = $this->automationOn($h, $store, 'thank_you', ['delay_hours' => 2]);
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant);
        [$r1, $r2] = $this->runsOf($tenant)->all();
        $this->assertSame(['waiting', 'waiting'], [$r1->status, $r2->status]);

        $this->planFor($tenant, Plan::FREE);
        $this->platformQuery(AutomationRun::class)->whereKey($r2->id)->update(['resume_at' => now()->addDays(2)]);
        $this->travel(3)->hours();
        $this->resumeDue();
        $this->assertSame(['stopped', 'plan'], [$r1->refresh()->status, $r1->outcome_reason]);

        $this->planFor($tenant, Plan::STARTER);
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/disable"))->assertOk();
        $this->assertSame(['stopped', 'automation_off'], [$r2->refresh()->status, $r2->outcome_reason]);
        $this->assertCount(0, $this->sms()->sent);

        $this->travel(91)->days();
        $this->artisan('automations:prune-runs')->assertSuccessful();
        $this->assertCount(0, $this->runsOf($tenant));
        $this->assertSame(0, $this->platformQuery(AutomationConversion::class)->where('tenant_id', $tenant->id)->count());
    }

    public function test_s140_dev_sink_records_automation_messages_and_s136_email_is_escaped(): void
    {
        config(['campaigns.dev_sink' => true]);
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store);
        $this->automationOn($h, $store, 'thank_you', ['message' => ['channel' => 'email', 'language' => 'en', 'subject' => 'Thanks {name}', 'body' => "Hi {name},\nthanks for {order_no}. {shop_link}"]]);
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false, 'contact' => ['name' => '<script>x</script> Rana', 'phone' => '01811223399', 'email' => 'rana@example.test']]))->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false] + ($step === 'ship' ? ['carrier_name' => 'Pathao'] : []))->assertOk();
        }
        $mails = $this->campaignMails();
        $this->assertCount(1, $mails);
        $html = $mails[0]->getOriginalMessage()->getHtmlBody();
        $this->assertStringNotContainsString('<script>', (string) $html);
        $this->assertStringContainsString('&lt;script&gt;', (string) $html);
        $sink = $this->api($h, 'GET', "/api/v1/dev/stores/{$store->id}/message-sink")->assertOk()->json('data');
        $this->assertCount(1, $sink);
        $this->assertSame(['email', 'rana@example.test', null, false], [$sink[0]['channel'], $sink[0]['to'], $sink[0]['campaign_id'], $sink[0]['is_test']]);
        $this->assertSame($this->runsOf($tenant)->first()->automation_id, $sink[0]['automation_id']);
        $this->assertSame(0, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'automation')->count());
    }

    /** @return array<string, int> */
    private function counts(): array
    {
        $out = [];
        foreach (self::TABLES as $table) {
            $out[$table] = $this->platformTable($table)->count();
        }
        $out['customer_tags'] = (int) $this->platformQuery(Customer::class)->get()->sum(fn ($c) => count($c->tags));
        $out['detected'] = $this->platformQuery(Cart::class)->whereNotNull('recovery_detected_at')->count();

        return $out;
    }
}
