<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Billing\Models\Plan;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-6 §9.1 automation routes: CRUD + settings validation per recipe, enable/disable/delete states, plan (S135),
 * authz (S131), cross-tenant / cross-store 404 (S130), audit (S139), list meta + detail shape (C3/C4).
 */
#[Group('automations')]
#[Group('security')]
class AutomationsApiTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_create_show_list_update_enable_disable_and_delete(): void
    {
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        $created = $this->createAutomation($h, $store, 'checkout_recovery');
        $this->assertSame('draft', $created['status']);
        $this->assertSame('Win back unfinished orders', $created['name']);
        $this->assertSame('Checkout left 30 min', $created['trigger_label']);
        $this->assertSame('Reminder SMS', $created['action_label']);
        foreach (['id', 'recipe', 'name', 'status', 'paused_reason', 'settings', 'trigger_label', 'action_label', 'runs_7d', 'last_run_at', 'created_at', 'updated_at', 'revision', 'recipe_schema', 'stats_7d', 'last_edited_by'] as $key) {
            $this->assertArrayHasKey($key, $created);
        }
        $this->assertSame(['delay_minutes', 'step1', 'wait_hours', 'step2', 'exit_days', 'skip_risky'], array_keys($created['settings']));
        $this->assertSame('bn', $created['settings']['step1']['message']['language'], 'defaults follow the store SMS language');
        $this->assertSame(['trigger', 'trigger_description', 'allowed_conditions', 'max_conditions', 'steps', 'merge_fields', 'sms_max_parts'], array_keys($created['recipe_schema']));
        $this->assertSame(['{name}', '{cart_link}', '{product}', '{coupon}', '{shop_link}'], $created['recipe_schema']['merge_fields']);
        $this->assertSame(3, $created['recipe_schema']['sms_max_parts']);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $created['last_edited_by']);
        $this->assertSame(['runs' => 0, 'completed' => 0, 'skipped' => 0, 'stopped' => 0, 'failed' => 0], $created['stats_7d']);

        $this->api($h, 'POST', $this->aUrl($store), ['recipe' => 'checkout_recovery'])->assertStatus(409)->assertJsonPath('error.code', 'automation_exists');
        $this->api($h, 'POST', $this->aUrl($store), ['recipe' => 'hold_risky_cod'])->assertStatus(422);

        $list = $this->api($h, 'GET', $this->aUrl($store))->assertOk();
        $list->assertJsonPath('data.0.id', $created['id']);
        $this->assertArrayNotHasKey('recipe_schema', $list->json('data.0'));
        $recipes = $list->json('meta.recipes');
        $this->assertSame(['checkout_recovery', 'thank_you', 'vip_tag', 'return_flag', 'low_stock'], array_column($recipes, 'recipe'));
        $this->assertSame([true, false, false, false, false], array_column($recipes, 'added'));
        $this->assertSame(['active' => 0, 'drafts' => 1, 'total' => 1, 'runs_7d' => 0, 'runs_7d_succeeded_pct' => null, 'messages_sent_month' => 0, 'carts_recovered_30d' => 0, 'recovered_revenue_30d' => 0], $list->json('meta.kpis'));

        $settings = $created['settings'];
        $settings['delay_minutes'] = 60;
        $settings['step1']['message'] = ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi {name}, finish here: {cart_link}', 'subject' => null];
        $updated = $this->api($h, 'PATCH', $this->aUrl($store, "/{$created['id']}"), ['name' => 'Recover carts', 'settings' => $settings, 'revision' => 1])
            ->assertOk()->json('data');
        $this->assertSame(['Recover carts', 60, 2, 'Checkout left 60 min'], [$updated['name'], $updated['settings']['delay_minutes'], $updated['revision'], $updated['trigger_label']]);
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$created['id']}"), ['name' => 'Stale', 'revision' => 1])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$created['id']}"), ['name' => 'X'])->assertStatus(422);

        $on = $this->api($h, 'POST', $this->aUrl($store, "/{$created['id']}/enable"))->assertOk()->json('data');
        $this->assertSame('on', $on['status']);
        $this->api($h, 'DELETE', $this->aUrl($store, "/{$created['id']}"))->assertStatus(409)->assertJsonPath('error.code', 'automation_not_draft');
        $this->api($h, 'POST', $this->aUrl($store, "/{$created['id']}/disable"))->assertOk()->assertJsonPath('data.status', 'off');
        $this->api($h, 'DELETE', $this->aUrl($store, "/{$created['id']}"))->assertStatus(409);

        $draft = $this->createAutomation($h, $store, 'low_stock');
        $this->api($h, 'DELETE', $this->aUrl($store, "/{$draft['id']}"))->assertNoContent();
        $this->api($h, 'GET', $this->aUrl($store, "/{$draft['id']}"))->assertNotFound();

        // S139: config-level audit rows with the actor; nothing per action.
        $actions = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'automation.%')->pluck('action')->countBy()->all();
        ksort($actions);
        $this->assertSame(['automation.created' => 2, 'automation.deleted' => 1, 'automation.disabled' => 1, 'automation.enabled' => 1, 'automation.updated' => 1], $actions);
        $row = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'automation.enabled')->first();
        $this->assertSame(['user', $owner->id, 'automation', $created['id']], [$row->actor_type, $row->actor_id, $row->subject_type, $row->subject_id]);
    }

    public function test_settings_are_validated_per_recipe(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $a = $this->createAutomation($h, $store, 'thank_you');
        $patch = fn (array $settings) => $this->api($h, 'PATCH', $this->aUrl($store, "/{$a['id']}"), ['settings' => $settings, 'revision' => $a['revision']]);
        $s = $a['settings'];

        $patch($s + ['extra' => 1])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $patch(['delay_hours' => 73] + $s)->assertStatus(422);
        $patch(array_replace($s, ['message' => ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi {cart_link}', 'subject' => null]]))
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_unknown_merge_field')->assertJsonPath('error.details.fields', ['{cart_link}']);
        $patch(array_replace($s, ['message' => ['channel' => 'sms', 'language' => 'en', 'body' => str_repeat('Long message ', 40), 'subject' => null]]))
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_too_long')->assertJsonPath('error.details.max_parts', 3);
        $patch(array_replace($s, ['message' => ['channel' => 'email', 'language' => 'en', 'body' => 'Thanks', 'subject' => "Hi\r\nBcc: x@y.z"]]))->assertStatus(422);
        $patch(array_replace($s, ['message' => ['channel' => 'email', 'language' => 'en', 'body' => 'Thanks', 'subject' => null]]))->assertStatus(422);
        $patch(array_replace($s, ['conditions' => [['field' => 'customer.risk', 'op' => 'is_not', 'value' => 'risky']]]))->assertStatus(422);
        $patch(array_replace($s, ['conditions' => [['field' => 'order.total_amount', 'op' => 'gte', 'value' => 100]]]))->assertStatus(422);
        $patch(array_replace($s, ['conditions' => array_fill(0, 6, ['field' => 'order.total_amount', 'op' => 'gt', 'value' => 100])]))->assertStatus(422);
        $ok = $patch(array_replace($s, ['delay_hours' => 2, 'conditions' => [
            ['field' => 'order.total_amount', 'op' => 'gt', 'value' => 100000],
            ['field' => 'order.payment_method', 'op' => 'is', 'value' => 'cod'],
            ['field' => 'order.channel', 'op' => 'in', 'value' => ['website', 'facebook']],
            ['field' => 'customer.tag', 'op' => 'not_has', 'value' => 'blocked'],
        ]]))->assertOk()->json('data');
        $this->assertCount(4, $ok['settings']['conditions']);

        // VIP: the message needs a coupon to be enabled (automation_incomplete), and only active coupons of the store.
        $vip = $this->createAutomation($h, $store, 'vip_tag');
        $this->api($h, 'POST', $this->aUrl($store, "/{$vip['id']}/enable"))->assertStatus(422)
            ->assertJsonPath('error.code', 'automation_incomplete')->assertJsonPath('error.details.fields', ['settings.coupon_id']);
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'VIP10', 'type' => 'fixed', 'amount' => 10000, 'status' => 'active'])->assertCreated()->json('data.id');
        $paused = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'OLD', 'type' => 'fixed', 'amount' => 100, 'status' => 'disabled'])->assertCreated()->json('data.id');
        $vs = $vip['settings'];
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$vip['id']}"), ['settings' => array_replace($vs, ['coupon_id' => $paused]), 'revision' => 1])
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_coupon_inactive');
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$vip['id']}"), ['settings' => array_replace($vs, ['coupon_id' => str_repeat('0', 26)]), 'revision' => 1])->assertStatus(422);
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$vip['id']}"), ['settings' => array_replace($vs, ['coupon_id' => $coupon, 'min_delivered' => 1]), 'revision' => 1])->assertStatus(422);
        $r = $this->api($h, 'PATCH', $this->aUrl($store, "/{$vip['id']}"), ['settings' => array_replace($vs, ['coupon_id' => $coupon]), 'revision' => 1]);
        $r->assertOk();
        $this->api($h, 'POST', $this->aUrl($store, "/{$vip['id']}/enable"))->assertOk()->assertJsonPath('data.action_label', 'Tag VIP + coupon')
            ->assertJsonPath('data.trigger_label', '5th delivery');

        $low = $this->createAutomation($h, $store, 'low_stock');
        $this->assertSame([], $low['settings']);
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$low['id']}"), ['settings' => ['threshold' => 3], 'revision' => 1])->assertStatus(422);
        $this->api($h, 'PATCH', $this->aUrl($store, "/{$low['id']}"), ['settings' => (object) [], 'revision' => 1])->assertOk();
    }

    public function test_free_plan_gets_402_and_downgrade_pauses(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop(Plan::FREE);
        $this->api($h, 'POST', $this->aUrl($store), ['recipe' => 'thank_you'])->assertStatus(402)
            ->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.feature', ['sms_automation']);

        $this->planFor($tenant, Plan::STARTER);
        $a = $this->automationOn($h, $store, 'thank_you');
        $this->planFor($tenant, Plan::FREE);
        $this->api($h, 'GET', $this->aUrl($store))->assertOk()->assertJsonPath('data.0.paused_reason', 'plan')->assertJsonPath('data.0.status', 'on');
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/disable"))->assertOk();
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/enable"))->assertStatus(402);
        $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/test-message"), ['step' => 1])->assertStatus(402);
        $this->assertSame('off', $this->automationRow($tenant, $a['id'])->status, 'settings and toggle kept, nothing deleted');
    }

    public function test_staff_is_forbidden_and_names_need_customers_view(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop(Plan::GROWTH); // custom roles
        [, $variant] = $this->stocked($h, $store);
        $a = $this->automationOn($h, $store, 'thank_you');
        $this->deliveredOrder($h, $store, $variant);
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        foreach ($this->routes($store, $a['id'], $this->runsOf($tenant)->first()->id) as [$method, $url, $body]) {
            $this->api($hs, $method, $url, $body)->assertForbidden();
        }

        $run = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/automation-runs")->assertOk()->json('data.0');
        $this->assertSame('Nusrat Jahan', $run['contact']['name']);
        $this->assertSame('+880 18•• •••344', $run['contact']['masked_address']);
        $this->assertArrayNotHasKey('contact_name', $run['context']);

        $marketer = $this->customRole($h, 'Marketer', ['marketing.manage']);
        [, $hm] = $this->memberWithRole($tenant, $marketer);
        $this->api($hm, 'GET', "/api/v1/stores/{$store->id}/automation-runs")->assertOk()->assertJsonPath('data.0.contact.name', null)
            ->assertJsonPath('data.0.contact.masked_address', '+880 18•• •••344');
        $this->api($hm, 'GET', $this->aUrl($store))->assertOk();
    }

    public function test_cross_tenant_and_cross_store_ids_answer_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->campaignShop(slug: 'alpha');
        [, $tenantB, $storeB, $hB] = $this->campaignShop(slug: 'beta');
        [, $variantB] = $this->stocked($hB, $storeB);
        $aB = $this->automationOn($hB, $storeB, 'thank_you');
        $this->deliveredOrder($hB, $storeB, $variantB);
        $runB = $this->runsOf($tenantB)->first()->id;

        $requests = array_merge(
            array_map(fn ($r) => [$r[0], $r[1], $r[2]], $this->routes($storeA, $aB['id'], $runB, withoutStoreLevel: true)),
            array_map(fn ($r) => [$r[0], $r[1], $r[2]], $this->routes($storeB, $aB['id'], $runB)),
        );
        $this->assertTenantIsolation($hA, $requests);

        foreach ([Automation::class, AutomationRun::class, AutomationRunStep::class, AutomationConversion::class] as $model) {
            $this->assertStoreIsolation($model, $tenantA, $storeA, $storeB);
        }
        $this->assertSame('on', $this->automationRow($tenantB, $aB['id'])->status);
        $this->assertCount(1, $this->runsOf($tenantB));
    }

    /** @return list<array{0: string, 1: string, 2: array<string, mixed>}> every §9.1 route */
    private function routes(Store $store, string $automation, string $run, bool $withoutStoreLevel = false): array
    {
        $a = $this->aUrl($store, "/{$automation}");
        $rows = [
            ['GET', $a, []],
            ['PATCH', $a, ['name' => 'X1', 'revision' => 1]],
            ['DELETE', $a, []],
            ['POST', "{$a}/enable", []],
            ['POST', "{$a}/disable", []],
            ['POST', "{$a}/dry-run", []],
            ['POST', "{$a}/test-message", ['step' => 1]],
            ['GET', "{$a}/stats", []],
            ['GET', "/api/v1/stores/{$store->id}/automation-runs/{$run}", []],
        ];
        if (! $withoutStoreLevel) {
            $rows = array_merge($rows, [
                ['GET', $this->aUrl($store), []],
                ['POST', $this->aUrl($store), ['recipe' => 'low_stock']],
                ['GET', "/api/v1/stores/{$store->id}/automation-runs", []],
            ]);
        }

        return $rows;
    }
}
