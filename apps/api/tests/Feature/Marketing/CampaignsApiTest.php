<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignConversion;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-5 §6.1 campaign routes: CRUD + validation, state machine (allowed / denied), schedule bounds and quiet hours
 * (S124), limits (S122, P85-27), authz (S120), cross-tenant / cross-store 404 (S119), audit (S126), idempotency.
 */
#[Group('campaigns')]
#[Group('security')]
class CampaignsApiTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_create_show_list_update_delete_a_draft(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $created = $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody([
            'audience' => ['segment' => 'repeat_inactive', 'params' => ['min_orders' => 3], 'exclude' => ['risky' => true, 'ordered_within_days' => 7]],
            'scheduled_at' => '2026-11-25T06:00:00Z',
        ]))->assertCreated()->json('data');

        $this->assertSame('draft', $created['status']);
        $this->assertSame(['segment' => 'repeat_inactive', 'params' => ['min_orders' => 3, 'inactive_days' => 60], 'exclude' => ['risky' => true, 'ordered_within_days' => 7]], $created['audience']);
        $this->assertSame('Bought 3+ times, inactive 60 days', $created['audience_label']);
        $this->assertSame('2026-11-25T06:00:00Z', $created['scheduled_at']);
        $this->assertNull($created['subject']);
        foreach (['id', 'name', 'channel', 'language', 'status', 'audience', 'audience_label', 'body', 'subject', 'coupon', 'product', 'scheduled_at', 'started_at', 'completed_at', 'cancelled_at', 'failure_reason', 'stats', 'created_by', 'created_at', 'updated_at', 'revision'] as $key) {
            $this->assertArrayHasKey($key, $created);
        }
        $this->assertSame(['recipients', 'sent', 'failed', 'skipped', 'unsubscribed', 'parts_sent', 'orders', 'revenue_amount', 'currency'], array_keys($created['stats']));

        $list = $this->api($h, 'GET', $this->cUrl($store))->assertOk();
        $list->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $created['id']);
        foreach (['body', 'subject', 'audience'] as $hidden) {
            $this->assertArrayNotHasKey($hidden, $list->json('data.0'));
        }
        $this->api($h, 'GET', $this->cUrl($store).'?status=sent,scheduled')->assertOk()->assertJsonPath('meta.total', 0);
        $this->api($h, 'GET', $this->cUrl($store).'?filter[status]=draft&q=EID')->assertOk()->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->cUrl($store).'?channel=email')->assertOk()->assertJsonPath('meta.total', 0);
        $this->api($h, 'GET', $this->cUrl($store).'?status=bogus')->assertStatus(422);

        $this->api($h, 'PATCH', $this->cUrl($store, "/{$created['id']}"), ['name' => 'Renamed', 'revision' => 1])
            ->assertOk()->assertJsonPath('data.name', 'Renamed')->assertJsonPath('data.revision', 2);
        $this->api($h, 'PATCH', $this->cUrl($store, "/{$created['id']}"), ['name' => 'Stale', 'revision' => 1])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', $this->cUrl($store, "/{$created['id']}"), ['name' => 'X'])->assertStatus(422);

        $copy = $this->api($h, 'POST', $this->cUrl($store, "/{$created['id']}/duplicate"))->assertCreated()->json('data');
        $this->assertSame('Renamed (copy)', $copy['name']);
        $this->assertSame('draft', $copy['status']);

        $this->api($h, 'DELETE', $this->cUrl($store, "/{$created['id']}"))->assertNoContent();
        $this->api($h, 'GET', $this->cUrl($store, "/{$created['id']}"))->assertNotFound();

        $actions = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'campaign.%')->pluck('action')->countBy()->all();
        $this->assertEquals(['campaign.created' => 2, 'campaign.deleted' => 1], $actions);
    }

    public function test_validation(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $url = $this->cUrl($store);
        $this->api($h, 'POST', $url, [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonValidationErrors(['name', 'channel', 'language', 'audience', 'body'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['name' => str_repeat('x', 81)]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['channel' => 'whatsapp']))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['language' => 'fr']))->assertStatus(422);
        // Audience: unknown keys and out-of-bounds params.
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'all', 'params' => [], 'exclude' => [], 'query' => 'x']]))
            ->assertStatus(422)->assertJsonValidationErrors(['audience.query'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'vip_plus']]))->assertStatus(422)->assertJsonValidationErrors(['audience.segment'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'repeat_inactive', 'params' => ['min_orders' => 1]]]))
            ->assertStatus(422)->assertJsonValidationErrors(['audience.params.min_orders'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'all', 'params' => ['days' => 3]]]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'district', 'params' => ['districts' => []]]]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'tag', 'params' => ['tag' => str_repeat('t', 41)]]]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['audience' => ['segment' => 'all', 'exclude' => ['ordered_within_days' => 61]]]))
            ->assertStatus(422)->assertJsonValidationErrors(['audience.exclude.ordered_within_days'], 'error.details');
        // Merge fields (P85-20).
        $this->api($h, 'POST', $url, $this->campaignBody(['body' => 'Hi {first_name}']))
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_unknown_merge_field')->assertJsonPath('error.details.fields', ['{first_name}']);
        $this->api($h, 'POST', $url, $this->campaignBody(['body' => 'Use {coupon}']))->assertStatus(422)->assertJsonValidationErrors(['coupon_id'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['body' => 'See {product}']))->assertStatus(422)->assertJsonValidationErrors(['product_id'], 'error.details');
        // SMS ≤ 5 parts including prefix + footer (P85-18).
        $this->api($h, 'POST', $url, $this->campaignBody(['body' => str_repeat('a', 900)]))
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_too_long')->assertJsonPath('error.details.max_parts', 5);
        // Email needs a subject; CR/LF in the subject or name is rejected (S123 header injection).
        $this->api($h, 'POST', $url, $this->campaignBody(['channel' => 'email']))->assertStatus(422)->assertJsonValidationErrors(['subject'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['channel' => 'email', 'subject' => "Hi\r\nBcc: x@example.com"]))->assertStatus(422)->assertJsonValidationErrors(['subject'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['name' => "A\nB"]))->assertStatus(422)->assertJsonValidationErrors(['name'], 'error.details');
        $this->api($h, 'POST', $url, $this->campaignBody(['channel' => 'email', 'subject' => 'S', 'body' => str_repeat('a', 5001)]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->campaignBody(['channel' => 'email', 'subject' => 'Eid', 'body' => str_repeat('a ', 2000)]))->assertCreated();
    }

    public function test_coupon_and_product_must_belong_to_the_store_and_the_coupon_must_be_active(): void
    {
        [, , $store, $h] = $this->campaignShop();
        [, , $otherStore, $hOther] = $this->campaignShop(slug: 'other');
        $foreignCoupon = $this->api($hOther, 'POST', "/api/v1/stores/{$otherStore->id}/coupons", ['code' => 'THEIRS', 'type' => 'fixed', 'amount' => 100, 'status' => 'active'])->assertCreated()->json('data.id');
        $draftCoupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'LATER', 'type' => 'fixed', 'amount' => 100])->assertCreated()->json('data.id');
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'EID20', 'type' => 'fixed', 'amount' => 100, 'status' => 'active'])->assertCreated()->json('data.id');
        [$product] = $this->stocked($h, $store);

        $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody(['body' => 'Use {coupon}', 'coupon_id' => $foreignCoupon]))->assertStatus(422)->assertJsonValidationErrors(['coupon_id'], 'error.details');
        $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody(['body' => 'Use {coupon}', 'coupon_id' => $draftCoupon]))
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_coupon_inactive');
        $data = $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody(['body' => 'Use {coupon}: {product}', 'coupon_id' => $coupon, 'product_id' => $product['id']]))
            ->assertCreated()->json('data');
        $this->assertSame(['id' => $coupon, 'code' => 'EID20'], $data['coupon']);
        $this->assertSame($product['id'], $data['product']['id']);
    }

    public function test_state_machine(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $tomorrow = '2026-11-25T06:00:00Z'; // noon Dhaka

        // draft → unschedule/... denied
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/unschedule"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        // draft → scheduled → draft → scheduled → cancelled
        $this->scheduleAt($h, $store, $id, $tomorrow)->assertOk()->assertJsonPath('data.status', 'scheduled')->assertJsonPath('data.scheduled_at', $tomorrow);
        $this->api($h, 'DELETE', $this->cUrl($store, "/{$id}"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/unschedule"))->assertOk()->assertJsonPath('data.status', 'draft');
        $this->scheduleAt($h, $store, $id, $tomorrow)->assertOk();
        $rev = $this->campaignRow($tenant, $id)->revision;
        // Editing a scheduled campaign re-validates the schedule (quiet hours: 22:00 Dhaka = 16:00 UTC).
        $this->api($h, 'PATCH', $this->cUrl($store, "/{$id}"), ['scheduled_at' => '2026-11-25T16:00:00Z', 'revision' => $rev])
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_quiet_hours');
        $this->api($h, 'PATCH', $this->cUrl($store, "/{$id}"), ['name' => 'Still scheduled', 'revision' => $rev])->assertOk()->assertJsonPath('data.status', 'scheduled');
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/cancel"))->assertOk()->assertJsonPath('data.status', 'cancelled')->assertJsonPath('data.cancelled_at', '2026-11-24T06:00:00Z');
        // terminal: nothing more
        foreach (['/cancel', '/unschedule'] as $action) {
            $this->api($h, 'POST', $this->cUrl($store, "/{$id}{$action}"))->assertStatus(409);
        }
        $this->sendNow($h, $store, $id)->assertStatus(409);
        $this->scheduleAt($h, $store, $id, $tomorrow)->assertStatus(409);
        $this->api($h, 'PATCH', $this->cUrl($store, "/{$id}"), ['name' => 'N', 'revision' => $this->campaignRow($tenant, $id)->revision])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'DELETE', $this->cUrl($store, "/{$id}"))->assertStatus(409);

        // draft → sending → sent, then cancel is refused
        $other = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $other)->assertStatus(202)->assertJsonPath('data.status', 'sending');
        $this->assertSame('sent', $this->campaignRow($tenant, $other)->status);
        $this->api($h, 'POST', $this->cUrl($store, "/{$other}/cancel"))->assertStatus(409);

        $actions = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'campaign.%')->orderBy('created_at')->pluck('action')->countBy()->all();
        $this->assertEquals(['campaign.created' => 2, 'campaign.scheduled' => 2, 'campaign.unscheduled' => 1, 'campaign.cancelled' => 1, 'campaign.sent' => 1], $actions);
        $actor = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'campaign.sent')->value('actor_type');
        $this->assertSame('user', $actor);
    }

    public function test_schedule_bounds_and_quiet_hours_in_store_time(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        // P85-16: ≥ now + 5 min, ≤ now + 90 days.
        $this->scheduleAt($h, $store, $id, '2026-11-24T06:04:00Z')->assertStatus(422)->assertJsonValidationErrors(['scheduled_at'], 'error.details');
        $this->scheduleAt($h, $store, $id, '2027-02-23T06:00:00Z')->assertStatus(422)->assertJsonValidationErrors(['scheduled_at'], 'error.details');
        $this->scheduleAt($h, $store, $id, 'soon')->assertStatus(422);
        // P85-15: 21:00–09:00 Dhaka (UTC+6) is quiet: 15:00 UTC = 21:00 → 422 with the next 09:00 (03:00 UTC).
        $this->scheduleAt($h, $store, $id, '2026-11-24T15:00:00Z')->assertStatus(422)->assertJsonPath('error.code', 'campaign_quiet_hours')
            ->assertJsonPath('error.details.allowed_from', '2026-11-25T03:00:00Z');
        $this->scheduleAt($h, $store, $id, '2026-11-25T02:59:00Z')->assertStatus(422)->assertJsonPath('error.code', 'campaign_quiet_hours');
        $this->scheduleAt($h, $store, $id, '2026-11-25T03:00:00Z')->assertOk();
        $this->scheduleAt($h, $store, $id, '2026-11-24T14:59:00Z')->assertOk(); // 20:59 Dhaka

        // Another store timezone: 15:00 UTC is 15:00 in London → fine there.
        $this->inTenant($store->tenant_id, fn () => Store::query()->whereKey($store->id)->update(['timezone' => 'Europe/London']));
        $this->scheduleAt($h, $store, $id, '2026-11-24T15:00:00Z')->assertOk();

        // Send now inside quiet hours (22:30 Dhaka).
        $this->inTenant($store->tenant_id, fn () => Store::query()->whereKey($store->id)->update(['timezone' => 'Asia/Dhaka']));
        Carbon::setTestNow(Carbon::parse('2026-11-24 16:30:00', 'UTC'));
        $draft = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $draft)->assertStatus(422)->assertJsonPath('error.code', 'campaign_quiet_hours')
            ->assertJsonPath('error.details.allowed_from', '2026-11-25T03:00:00Z');
    }

    public function test_schedule_and_send_require_a_live_store_recipients_and_an_idempotency_key(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(422)->assertJsonPath('error.code', 'campaign_no_recipients');
        $this->scheduleAt($h, $store, $id, '2026-11-25T06:00:00Z')->assertStatus(422)->assertJsonPath('error.code', 'campaign_no_recipients');
        $this->customer($h, $store);
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/send"))->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $first = $this->sendNow($h, $store, $id, 'send-key-0001')->assertStatus(202);
        $replay = $this->sendNow($h, $store, $id, 'send-key-0001')->assertStatus(202)->assertHeader('Idempotent-Replayed', 'true');
        $this->assertSame($first->json('data.id'), $replay->json('data.id'));
        $this->assertCount(1, $this->sms()->sent);

        // P85-24: a draft (or suspended) store can't create / schedule / send.
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody())->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_ACTIVE]));
        $draft = $this->createCampaign($h, $store);
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_SUSPENDED]));
        $this->sendNow($h, $store, $draft)->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
        $this->scheduleAt($h, $store, $draft, '2026-11-25T06:00:00Z')->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
    }

    public function test_open_campaign_bound_and_three_sending_at_once(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        config(['campaigns.max_open_per_store' => 2]);
        $this->createCampaign($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody())->assertStatus(422)->assertJsonPath('error.code', 'limit_reached');
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/duplicate"))->assertStatus(422)->assertJsonPath('error.code', 'limit_reached');
        config(['campaigns.max_open_per_store' => 50]);

        // P85-27 / §9.1: with 3 already sending, "send now" answers 202 and leaves the campaign scheduled.
        $this->inTenant($tenant, function () use ($store) {
            foreach (range(1, 3) as $i) {
                $c = new Campaign;
                $c->store_id = $store->id;
                $c->name = "Busy {$i}";
                $c->channel = 'sms';
                $c->language = 'en';
                $c->audience = ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => false, 'ordered_within_days' => null]];
                $c->body = 'x';
                $c->status = Campaign::SENDING;
                $c->started_at = now();
                $c->save();
            }
        });
        $this->sendNow($h, $store, $id)->assertStatus(202)->assertJsonPath('data.status', 'scheduled')->assertJsonPath('data.scheduled_at', '2026-11-24T06:00:00Z');
        $this->assertSame([], $this->sms()->sent);
    }

    public function test_free_plan_and_allowance_limits(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop(Plan::FREE);
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store); // drafts are allowed on Free
        $this->sendNow($h, $store, $id)->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached')
            ->assertJsonPath('error.details.campaign_sms_per_month.limit', 0)
            ->assertJsonPath('error.details.upgrade_plan', ['starter']);
        $this->scheduleAt($h, $store, $id, '2026-11-25T06:00:00Z')->assertStatus(402);
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/test"))->assertStatus(402);

        // Starter with a small allowance: the estimate (recipients × parts) must fit.
        $this->planFor($tenant, Plan::STARTER);
        $this->platformTable('plans')->where('code', 'starter')->update(['limits' => json_encode(['campaign_sms_per_month' => 2, 'campaign_emails_per_month' => 5000])]);
        FeatureGate::forget($tenant->id);
        $this->customer($h, $store);
        $this->customer($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(402)
            ->assertJsonPath('error.details.campaign_sms_per_month', ['limit' => 2, 'used' => 0, 'needed' => 3]);
        $this->api($h, 'POST', $this->cUrl($store, '/estimate'), [
            'channel' => 'sms', 'language' => 'en', 'body' => 'Hi {name}', 'audience' => $this->campaignBody()['audience'],
        ])->assertOk()->assertJsonPath('data.recipients', 3)->assertJsonPath('data.total_parts', 3)
            ->assertJsonPath('data.allowance', ['limit' => 2, 'used' => 0, 'remaining' => 2, 'after' => -1, 'credits' => 0]);
    }

    public function test_estimate_and_preview(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $this->customer($h, $store, ['email' => 'a@example.com']);
        $audience = $this->campaignBody()['audience'];
        $sms = $this->api($h, 'POST', $this->cUrl($store, '/estimate'), ['channel' => 'sms', 'language' => 'bn', 'body' => '{name}, ঈদ মোবারক!', 'audience' => $audience])->assertOk()->json('data');
        $this->assertSame('ucs2', $sms['encoding']);
        $this->assertSame(1, $sms['recipients']);
        $this->assertGreaterThanOrEqual(1, $sms['parts_per_recipient']);
        $this->assertSame(['limit' => 1000, 'used' => 0, 'remaining' => 1000, 'after' => 1000 - $sms['total_parts'], 'credits' => 0], $sms['allowance']);
        $email = $this->api($h, 'POST', $this->cUrl($store, '/estimate'), ['channel' => 'email', 'language' => 'en', 'body' => 'Hello there', 'subject' => 'Hi', 'audience' => $audience])->assertOk()->json('data');
        $this->assertSame(['recipients' => 1, 'parts_per_recipient' => 1, 'total_parts' => 1, 'encoding' => null, 'characters' => 11], array_diff_key($email, ['allowance' => 1]));
        $this->assertSame(5000, $email['allowance']['limit']);
        $this->api($h, 'POST', $this->cUrl($store, '/estimate'), ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi {nam}', 'audience' => $audience])
            ->assertStatus(422)->assertJsonPath('error.code', 'campaign_unknown_merge_field');
        // A too-long text still estimates (the composer shows "cut n characters").
        $this->api($h, 'POST', $this->cUrl($store, '/estimate'), ['channel' => 'sms', 'language' => 'en', 'body' => str_repeat('a', 900), 'audience' => $audience])
            ->assertOk()->assertJsonPath('data.parts_per_recipient', 7);
        $this->api($h, 'POST', $this->cUrl($store, '/audience-preview'), ['channel' => 'sms'])->assertStatus(422);
    }

    public function test_test_send_sms_and_email(): void
    {
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        $sms = $this->createCampaign($h, $store);
        $this->api($h, 'POST', $this->cUrl($store, "/{$sms}/test"))->assertStatus(422)->assertJsonValidationErrors(['channel'], 'error.details');
        $owner->forceFill(['phone' => '8801911000111', 'phone_verified_at' => now()])->save();
        $this->api($h, 'POST', $this->cUrl($store, "/{$sms}/test"))->assertStatus(202)->assertJsonPath('data.to_masked', '+880 19•• •••111');
        $this->assertCount(1, $this->sms()->sent);
        $this->assertSame('8801911000111', $this->sms()->sent[0]['to']);
        $this->assertMatchesRegularExpression('~\nSTOP: [a-z0-9.]+/u/[A-Za-z0-9]{10}$~', $this->sms()->sent[0]['text']);

        $email = $this->createCampaign($h, $store, ['channel' => 'email', 'subject' => 'Eid sale for {name}']);
        $this->api($h, 'POST', $this->cUrl($store, "/{$email}/test"))->assertStatus(202)->assertJsonPath('data.to_masked', mb_substr($owner->email, 0, 1).'•••'.substr($owner->email, strpos($owner->email, '@')));
        $this->assertCount(1, $this->campaignMails());

        // Counted toward the allowance (P85-26) and audited with the actor.
        $this->inTenant($tenant, function () {
            $this->assertSame(1, CampaignAllowance::used('sms'));
            $this->assertSame(1, CampaignAllowance::used('email'));
        });
        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'campaign.test_sent')->get();
        $this->assertCount(2, $audit);
        $this->assertSame($owner->id, $audit[0]->actor_id);
        $this->assertStringNotContainsString('8801911000111', json_encode($audit[0]->meta), 'no contact values in audit meta');

        // Terminal campaigns and a store that isn't live → 409.
        $this->api($h, 'POST', $this->cUrl($store, "/{$email}/cancel"))->assertOk();
        $this->api($h, 'POST', $this->cUrl($store, "/{$email}/test"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        // 5 per hour per user.
        foreach (range(1, 3) as $i) {
            $this->api($h, 'POST', $this->cUrl($store, "/{$sms}/test"))->assertStatus(202);
        }
        $this->api($h, 'POST', $this->cUrl($store, "/{$sms}/test"))->assertStatus(429);
    }

    public function test_staff_and_custom_roles(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop(Plan::GROWTH);
        $customer = $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        [, $hs] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        [, $ha] = $this->memberAs($tenant, TenantUser::ROLE_ADMIN);
        $requests = $this->routes($store, $id, $customer->id);
        foreach ($requests as [$method, $url, $body]) {
            if (str_contains($url, 'marketing-opt-out')) {
                continue; // customers.edit: staff has it (asserted below)
            }
            $this->api($hs + ['Idempotency-Key' => (string) Str::uuid()], $method, $url, $body)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        $this->api($ha, 'GET', $this->cUrl($store, "/{$id}/recipients"))->assertOk();
        $this->api($hs, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();

        // Recipients need customers.view too; marketing.manage alone can't list them.
        $marketer = $this->customRole($h, 'Marketer', ['marketing.manage']);
        [, $hm] = $this->memberWithRole($tenant, $marketer);
        $this->api($hm, 'GET', $this->cUrl($store, "/{$id}"))->assertOk();
        $this->api($hm, 'GET', $this->cUrl($store, "/{$id}/recipients"))->assertForbidden();
        $both = $this->customRole($h, 'Marketer+', ['marketing.manage', 'customers.view']);
        [, $hb] = $this->memberWithRole($tenant, $both);
        $this->api($hb, 'GET', $this->cUrl($store, "/{$id}/recipients"))->assertOk();
        // The opt-out toggle is customers.edit.
        $editor = $this->customRole($h, 'Editor', ['customers.view', 'customers.edit']);
        [, $he] = $this->memberWithRole($tenant, $editor);
        $this->api($he, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();
        $this->api($he, 'GET', $this->cUrl($store))->assertForbidden();
    }

    public function test_cross_tenant_and_cross_store_ids_answer_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->campaignShop(slug: 'alpha');
        [, $tenantB, $storeB, $hB] = $this->campaignShop(slug: 'beta');
        $customerB = $this->customer($hB, $storeB);
        $idB = $this->createCampaign($hB, $storeB);
        $this->sendNow($hB, $storeB, $idB)->assertStatus(202);

        // A's store with B's ids → 404; B's store URL with A's tenant header → 404.
        $requests = array_merge(
            array_map(fn ($r) => [$r[0], $r[1], $r[2]], $this->routes($storeA, $idB, $customerB->id, withoutStoreLevel: true)),
            array_map(fn ($r) => [$r[0], $r[1], $r[2]], $this->routes($storeB, $idB, $customerB->id)),
        );
        $this->assertTenantIsolation($hA + ['Idempotency-Key' => 'isolation-key-1'], $requests);

        foreach ([Campaign::class, CampaignRecipient::class, CampaignConversion::class, MarketingSuppression::class] as $model) {
            $this->assertStoreIsolation($model, $tenantA, $storeA, $storeB);
        }
        $this->assertSame(1, $this->recipientsOf($tenantB, $idB)->count());
    }

    /** @return list<array{0: string, 1: string, 2: array<string, mixed>}> every §6.1 route */
    private function routes(Store $store, string $campaign, string $customer, bool $withoutStoreLevel = false): array
    {
        $c = $this->cUrl($store, "/{$campaign}");
        $rows = [
            ['GET', $c, []],
            ['PATCH', $c, ['name' => 'X', 'revision' => 1]],
            ['DELETE', $c, []],
            ['POST', "{$c}/test", []],
            ['POST', "{$c}/schedule", ['scheduled_at' => '2026-11-25T06:00:00Z']],
            ['POST', "{$c}/send", []],
            ['POST', "{$c}/unschedule", []],
            ['POST', "{$c}/cancel", []],
            ['POST', "{$c}/duplicate", []],
            ['GET', "{$c}/recipients", []],
            ['POST', "/api/v1/stores/{$store->id}/customers/{$customer}/marketing-opt-out", ['channel' => 'sms']],
            ['DELETE', "/api/v1/stores/{$store->id}/customers/{$customer}/marketing-opt-out/sms", []],
        ];
        if (! $withoutStoreLevel) {
            $rows = array_merge($rows, [
                ['GET', $this->cUrl($store), []],
                ['POST', $this->cUrl($store), $this->campaignBody()],
                ['POST', $this->cUrl($store, '/audience-preview'), ['channel' => 'sms', 'audience' => $this->campaignBody()['audience']]],
                ['POST', $this->cUrl($store, '/estimate'), ['channel' => 'sms', 'language' => 'en', 'body' => 'x', 'audience' => $this->campaignBody()['audience']]],
                ['GET', "/api/v1/stores/{$store->id}/marketing/overview", []],
            ]);
        }

        return $rows;
    }
}
