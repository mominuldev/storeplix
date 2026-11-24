<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\Plan;
use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\CampaignPipeline;
use App\Domain\Marketing\Jobs\SendCampaignBatch;
use App\Domain\Marketing\Jobs\StartCampaign;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Marketing\UnsubscribeCodes;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-5 §5 send pipeline with the fake SMS gateway and the `array` campaign mailer: snapshot → batches → sent,
 * counters, sms_messages rows, email headers (S115), opt-out at send time (S113, S114), at-most-once (S121), cancel
 * while sending, quiet-hours pause/resume (S124), reap-stuck, execution-time allowance (S122), store unavailable,
 * recipients list (S120 masking), retention.
 */
#[Group('campaigns')]
#[Group('security')]
class CampaignPipelineTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_sms_campaign_sends_once_per_eligible_customer_with_prefix_footer_and_counters(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store, ['name' => 'Karim Uddin']);
        $this->customer($h, $store, ['name' => 'নুসরাত জাহান', 'accepts_marketing' => false], ['orders_count' => 1]); // soft opt-in (P85-3)
        $this->customer($h, $store, ['accepts_marketing' => false]); // never messaged
        $this->customer($h, $store, ['phone' => null, 'email' => 'noaddress@example.com']);

        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202)->assertJsonPath('data.status', 'sending');

        $sent = $this->sms()->sent;
        $this->assertCount(2, $sent);
        $host = $this->host($store);
        $this->assertStringStartsWith(substr($store->name, 0, 20).': Hi Karim, 10% off everything this week.', $sent[0]['text']);
        $this->assertMatchesRegularExpression('~\nSTOP: '.preg_quote($host, '~').'/u/[A-Za-z0-9]{10}$~', $sent[0]['text']);
        $this->assertStringContainsString('Hi নুসরাত,', $sent[1]['text']);

        $campaign = $this->campaignRow($tenant, $id);
        $this->assertSame('sent', $campaign->status);
        $this->assertNotNull($campaign->completed_at);
        $this->assertSame([2, 2, 0, 0], [$campaign->recipients_count, $campaign->sent_count, $campaign->failed_count, $campaign->skipped_count]);
        $recipients = $this->recipientsOf($tenant, $id);
        $this->assertSame($recipients->sum('parts'), $campaign->parts_sent);
        $this->assertSame(['sent', 'sent'], $recipients->pluck('status')->all());

        // S115/P85-6: each message's code works and only its sha256 is stored (column scan).
        foreach ($sent as $message) {
            $code = $this->codeIn($message['text']);
            $this->assertSame(1, $recipients->where('unsubscribe_code_hash', UnsubscribeCodes::hash($code))->count());
            $this->assertSame(0, $this->platformTable('campaign_recipients')->where('unsubscribe_code_hash', $code)->count());
            $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk()->assertJsonPath('data.status', 'subscribed');
        }

        // sms_messages rows: purpose campaign, template campaign:{id}, no body; order SMS usage unchanged (S122).
        $rows = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'campaign')->get();
        $this->assertCount(2, $rows);
        $this->assertSame(["campaign:{$id}"], $rows->pluck('template')->unique()->values()->all());
        $tenantModel = Tenant::query()->find($tenant->id);
        $this->assertSame(0, FeatureGate::usage($tenantModel, Limit::SmsPerMonth));
        $this->assertSame($campaign->parts_sent, FeatureGate::usage($tenantModel, Limit::CampaignSmsPerMonth));

        // Recipients list: masked addresses only (S120).
        $list = $this->api($h, 'GET', $this->cUrl($store, "/{$id}/recipients"))->assertOk();
        $list->assertJsonCount(2, 'data')->assertJsonPath('meta.per_page', 50);
        $this->assertMatchesRegularExpression('/^\+880 17•• •••\d{3}$/', $list->json('data.0.masked_address'));
        $this->assertStringNotContainsString('88017', (string) $list->getContent());
        $this->api($h, 'GET', $this->cUrl($store, "/{$id}/recipients").'?status=failed')->assertOk()->assertJsonCount(0, 'data');
    }

    public function test_email_campaign_carries_list_unsubscribe_headers_and_a_working_link(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store, ['email' => 'Rafi@Example.com', 'phone' => null]);
        $id = $this->createCampaign($h, $store, ['channel' => 'email', 'subject' => 'Eid sale for {name}', 'body' => "Hi {name},\n\n<script>x</script> visit {shop_link}"]);
        $this->sendNow($h, $store, $id)->assertStatus(202);

        $mails = $this->campaignMails();
        $this->assertCount(1, $mails);
        $email = $mails[0]->getOriginalMessage();
        $this->assertSame('rafi@example.com', $email->getTo()[0]->getAddress());
        $this->assertSame('shop@example.test', $email->getReplyTo()[0]->getAddress());
        $this->assertSame($store->name, $email->getFrom()[0]->getName());
        $this->assertStringStartsWith('Eid sale for Rahim', $email->getSubject());
        $unsub = $email->getHeaders()->get('List-Unsubscribe')->getBodyAsString();
        $this->assertMatchesRegularExpression('~^<https://'.preg_quote($this->host($store), '~').'/u/[A-Za-z0-9]{10}/one-click>$~', $unsub);
        $this->assertSame('List-Unsubscribe=One-Click', $email->getHeaders()->get('List-Unsubscribe-Post')->getBodyAsString());
        $this->assertStringContainsString('&lt;script&gt;', (string) $email->getHtmlBody());
        $this->assertStringNotContainsString('<script>', (string) $email->getHtmlBody());
        $code = $this->codeIn($unsub);
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe', 'one_click' => true])->assertOk()->assertJsonPath('data.status', 'unsubscribed');
        $this->assertSame(1, $this->campaignRow($tenant, $id)->unsubscribed_count);
    }

    public function test_opt_out_after_the_snapshot_wins_at_send_time(): void
    {
        // S113 / AC 1
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        $karim = $this->customer($h, $store);
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        $this->assertSame(['queued', 'queued'], $this->recipientsOf($tenant, $id)->pluck('status')->all());

        // The customer opts out (merchant toggle here; the link path is covered in UnsubscribeTest) before the batch runs.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$karim->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk()
            ->assertJsonPath('data.sms', 'unsubscribed')->assertJsonPath('data.unsubscribed_source.sms', 'merchant');
        $this->runBatches($tenant);

        $this->assertNotContains($karim->phone, array_column($this->sms()->sent, 'to'), 'the provider was never called for that address');
        $this->assertCount(1, $this->sms()->sent);
        $row = $this->recipientsOf($tenant, $id)->firstWhere('customer_id', $karim->id);
        $this->assertSame(['skipped', 'opted_out'], [$row->status, $row->skip_reason]);
        $this->assertSame('sent', $this->campaignRow($tenant, $id)->status);
        $this->api($h, 'GET', $this->cUrl($store, "/{$id}/recipients").'?skip_reason=opted_out')->assertOk()->assertJsonCount(1, 'data');
    }

    public function test_suppression_follows_the_address_across_customer_delete_and_recreate(): void
    {
        // S114
        [, $tenant, $store, $h] = $this->campaignShop();
        $karim = $this->customer($h, $store, ['phone' => '01712000111']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$karim->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();
        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/customers/{$karim->id}")->assertNoContent();
        $again = $this->customer($h, $store, ['phone' => '+880 1712-000111', 'accepts_marketing' => true]);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$again->id}")->assertOk()->assertJsonPath('data.marketing.sms', 'unsubscribed');

        $this->api($h, 'POST', $this->cUrl($store, '/audience-preview'), ['channel' => 'sms', 'audience' => $this->campaignBody()['audience']])
            ->assertOk()->assertJsonPath('data.recipients', 0)->assertJsonPath('data.excluded.opted_out', 1);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(422)->assertJsonPath('error.code', 'campaign_no_recipients');
        $this->assertSame([], $this->sms()->sent);
    }

    public function test_send_time_checks_deleted_changed_and_ineligible_customers(): void
    {
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        $deleted = $this->customer($h, $store);
        $changed = $this->customer($h, $store);
        $ineligible = $this->customer($h, $store);
        $ok = $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));

        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/customers/{$deleted->id}")->assertNoContent();
        $this->inTenant($tenant, function () use ($changed, $ineligible) {
            Customer::query()->whereKey($changed->id)->update(['phone' => '8801799999999']);
            Customer::query()->whereKey($ineligible->id)->update(['accepts_marketing' => false]);
        });
        $this->runBatches($tenant);

        $reasons = $this->recipientsOf($tenant, $id)->mapWithKeys(fn ($r) => [$r->customer_id => $r->skip_reason ?? $r->status])->all();
        $this->assertSame('customer_deleted', $reasons[$deleted->id]);
        $this->assertSame('address_changed', $reasons[$changed->id]);
        $this->assertSame('not_eligible', $reasons[$ineligible->id]);
        $this->assertSame('sent', $reasons[$ok->id]);
        $this->assertSame([$ok->phone], array_column($this->sms()->sent, 'to'));
        $campaign = $this->campaignRow($tenant, $id);
        $this->assertSame([4, 1, 3], [$campaign->recipients_count, $campaign->sent_count, $campaign->skipped_count]);
    }

    public function test_at_most_once_under_duplicated_jobs_and_double_dispatch(): void
    {
        // S121
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        foreach (range(1, 3) as $i) {
            $this->customer($h, $store);
        }
        $id = $this->createCampaign($h, $store);
        $this->scheduleAt($h, $store, $id, '2026-11-24T07:00:00Z')->assertOk();
        Carbon::setTestNow(Carbon::parse('2026-11-24 07:00:30', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->assertSame('sending', $this->campaignRow($tenant, $id)->status);
        Queue::assertPushed(StartCampaign::class, 1);

        // Two copies of the start, then every batch run twice (two workers).
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        $this->assertSame(3, $this->recipientsOf($tenant, $id)->count());
        $this->runBatches($tenant);
        $this->runBatches($tenant);
        $this->assertCount(3, $this->sms()->sent);
        $this->assertSame(3, count(array_unique(array_column($this->sms()->sent, 'to'))));

        // A recipient stuck in `sending` is never sent again: reap → unknown, still never sent.
        $this->inTenant($tenant, fn () => CampaignRecipient::query()->where('campaign_id', $id)->limit(1)->update(['status' => 'sending', 'updated_at' => now()->subMinutes(20)]));
        $this->runBatches($tenant);
        $this->artisan('campaigns:reap-stuck')->assertSuccessful();
        $this->assertSame(1, $this->recipientsOf($tenant, $id)->where('status', 'unknown')->count());
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->runBatches($tenant);
        $this->assertCount(3, $this->sms()->sent);
    }

    public function test_reap_stuck_marks_unknown_and_finishes_the_campaign(): void
    {
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        // A worker claimed the row and died before the provider answer.
        $this->inTenant($tenant, fn () => CampaignRecipient::query()->where('campaign_id', $id)->update(['status' => 'sending', 'updated_at' => now()]));
        Carbon::setTestNow(now()->addMinutes(10));
        $this->artisan('campaigns:reap-stuck')->assertSuccessful();
        $this->assertSame('sending', $this->recipientsOf($tenant, $id)->first()->status);
        Carbon::setTestNow(now()->addMinutes(6));
        $this->artisan('campaigns:reap-stuck')->assertSuccessful();
        $this->assertSame('unknown', $this->recipientsOf($tenant, $id)->first()->status);
        $this->assertSame('sent', $this->campaignRow($tenant, $id)->status);
        $this->assertSame([], $this->sms()->sent);
    }

    public function test_cancel_while_sending_skips_the_remaining_recipients(): void
    {
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        config(['campaigns.batch_size' => 1]);
        [, $tenant, $store, $h] = $this->campaignShop();
        foreach (range(1, 3) as $i) {
            $this->customer($h, $store);
        }
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        $batches = Queue::pushed(SendCampaignBatch::class)->values();
        $this->assertCount(3, $batches);
        $this->inTenant($tenant, fn () => $batches[0]->handle(app(CampaignPipeline::class)));

        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/cancel"))->assertOk()->assertJsonPath('data.status', 'cancelled')
            ->assertJsonPath('data.stats.sent', 1)->assertJsonPath('data.stats.skipped', 2);
        $this->inTenant($tenant, fn () => $batches[1]->handle(app(CampaignPipeline::class)));
        $this->assertCount(1, $this->sms()->sent);
        $this->assertSame(['sent', 'skipped', 'skipped'], $this->recipientsOf($tenant, $id)->pluck('status')->all());
        $this->assertSame(['cancelled', 'cancelled'], $this->recipientsOf($tenant, $id)->where('status', 'skipped')->pluck('skip_reason')->values()->all());
        $this->assertSame('cancelled', $this->campaignRow($tenant, $id)->status);
    }

    public function test_quiet_hours_pause_and_resume(): void
    {
        // S124 / P85-15: sending at 21:00 pauses until 09:00 store time.
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        config(['campaigns.batch_size' => 1]);
        [, $tenant, $store, $h] = $this->campaignShop();
        foreach (range(1, 2) as $i) {
            $this->customer($h, $store);
        }
        Carbon::setTestNow(Carbon::parse('2026-11-24 14:59:00', 'UTC')); // 20:59 Dhaka
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        $batches = Queue::pushed(SendCampaignBatch::class)->values();
        $this->inTenant($tenant, fn () => $batches[0]->handle(app(CampaignPipeline::class)));
        Carbon::setTestNow(Carbon::parse('2026-11-24 15:00:00', 'UTC')); // 21:00 Dhaka
        $this->inTenant($tenant, fn () => $batches[1]->handle(app(CampaignPipeline::class)));
        $this->assertCount(1, $this->sms()->sent);
        $this->assertSame(['sent', 'queued'], $this->recipientsOf($tenant, $id)->pluck('status')->all());

        // dispatch-due doesn't resume during quiet hours …
        Carbon::setTestNow(Carbon::parse('2026-11-25 02:59:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        Queue::assertPushed(SendCampaignBatch::class, 2);
        // … and does from 09:00.
        Carbon::setTestNow(Carbon::parse('2026-11-25 03:01:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        Queue::assertPushed(SendCampaignBatch::class, 3);
        $this->runBatches($tenant);
        $this->assertCount(2, $this->sms()->sent);
        $this->assertSame('sent', $this->campaignRow($tenant, $id)->status);
    }

    public function test_a_batch_stops_at_its_time_budget_and_dispatch_due_resumes_it(): void
    {
        // Jobs must end well before REDIS_QUEUE_RETRY_AFTER: past `batch_budget_seconds` nothing more is claimed.
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($id));
        config(['campaigns.batch_budget_seconds' => -1]);
        $this->runBatches($tenant);
        $this->assertSame([], $this->sms()->sent);
        $this->assertSame(['queued', 'queued'], $this->recipientsOf($tenant, $id)->pluck('status')->all());
        $this->assertSame('sending', $this->campaignRow($tenant, $id)->status);

        config(['campaigns.batch_budget_seconds' => 150]);
        Carbon::setTestNow(now()->addMinutes(3));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->runBatches($tenant);
        $this->assertCount(2, $this->sms()->sent);
        $this->assertSame('sent', $this->campaignRow($tenant, $id)->status);
        $this->assertSame(240, (new StartCampaign($id))->timeout);
        $this->assertSame(240, (new SendCampaignBatch($id, []))->timeout);
    }

    public function test_dispatch_due_respects_quiet_hours_and_three_sending_slots(): void
    {
        Queue::fake([StartCampaign::class, SendCampaignBatch::class]);
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $ids = [];
        foreach (range(1, 4) as $i) {
            $ids[] = $id = $this->createCampaign($h, $store);
            $this->scheduleAt($h, $store, $id, '2026-11-24T14:00:00Z')->assertOk(); // 20:00 Dhaka
        }
        Carbon::setTestNow(Carbon::parse('2026-11-24 13:59:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        Queue::assertNotPushed(StartCampaign::class);
        Carbon::setTestNow(Carbon::parse('2026-11-24 14:00:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $statuses = collect($ids)->map(fn ($id) => $this->campaignRow($tenant, $id)->status)->countBy()->all();
        $this->assertEquals(['sending' => 3, 'scheduled' => 1], $statuses);
        Queue::assertPushed(StartCampaign::class, 3);
        // The 4th waits; past 21:00 it does not start even when a slot frees.
        $this->inTenant($tenant, fn () => Campaign::query()->whereIn('id', $ids)->where('status', 'sending')->limit(1)->update(['status' => 'sent']));
        Carbon::setTestNow(Carbon::parse('2026-11-24 15:30:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        Queue::assertPushed(StartCampaign::class, 3);
        Carbon::setTestNow(Carbon::parse('2026-11-25 03:00:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->assertSame([], collect($ids)->filter(fn ($id) => $this->campaignRow($tenant, $id)->status === 'scheduled')->all());
        // Every campaign got a start; the ones whose (faked) start never ran are re-kicked (lost-start recovery).
        $this->assertEqualsCanonicalizing($ids, Queue::pushed(StartCampaign::class)->map(fn ($j) => $j->campaignId)->unique()->values()->all());
    }

    public function test_execution_checks_allowance_store_and_audience(): void
    {
        // S122: the exact count after the snapshot doesn't fit → failed/limit, zero sends.
        [, $tenant, $store, $h] = $this->campaignShop();
        foreach (range(1, 3) as $i) {
            $this->customer($h, $store);
        }
        $id = $this->createCampaign($h, $store);
        $this->scheduleAt($h, $store, $id, '2026-11-24T07:00:00Z')->assertOk();
        $this->platformTable('plans')->where('code', Plan::STARTER)->update(['limits' => json_encode(['campaign_sms_per_month' => 2, 'campaign_emails_per_month' => 10])]);
        FeatureGate::forget($tenant->id);
        Carbon::setTestNow(Carbon::parse('2026-11-24 07:01:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $campaign = $this->campaignRow($tenant, $id);
        $this->assertSame(['failed', 'limit'], [$campaign->status, $campaign->failure_reason]);
        $this->assertSame([], $this->sms()->sent);
        $this->assertSame(['skipped'], $this->recipientsOf($tenant, $id)->pluck('status')->unique()->values()->all());

        // Downgraded to Free → failed/plan; store no longer live → failed/store_unavailable; nobody left → no_recipients.
        $this->platformTable('plans')->where('code', Plan::STARTER)->update(['limits' => json_encode(['campaign_sms_per_month' => 1000, 'campaign_emails_per_month' => 5000])]);
        FeatureGate::forget($tenant->id);
        $plan = $this->createCampaign($h, $store);
        $gone = $this->createCampaign($h, $store);
        $empty = $this->createCampaign($h, $store, ['audience' => ['segment' => 'tag', 'params' => ['tag' => 'vip']]]);
        $this->inTenant($tenant, fn () => Customer::query()->whereKey($this->inTenant($tenant, fn () => Customer::query()->value('id')))->update(['tags' => json_encode(['vip'])]));
        foreach ([$plan, $gone, $empty] as $c) {
            $this->scheduleAt($h, $store, $c, '2026-11-24T08:00:00Z')->assertOk();
        }
        $this->inTenant($tenant, fn () => Customer::query()->update(['tags' => '[]']));
        Carbon::setTestNow(Carbon::parse('2026-11-24 08:00:00', 'UTC'));
        $this->inTenant($tenant, fn () => Campaign::query()->whereKey($plan)->update(['status' => 'sending', 'started_at' => now()]));
        $this->planFor($tenant, Plan::FREE);
        $this->inTenant($tenant, fn () => app(CampaignPipeline::class)->start($plan));
        $this->assertSame(['failed', 'plan'], [$this->campaignRow($tenant, $plan)->status, $this->campaignRow($tenant, $plan)->failure_reason]);
        $this->planFor($tenant, Plan::STARTER);
        $this->artisan('campaigns:dispatch-due')->assertSuccessful(); // starts $empty (and $gone)
        $this->assertSame(['failed', 'no_recipients'], [$this->campaignRow($tenant, $empty)->status, $this->campaignRow($tenant, $empty)->failure_reason]);
        $this->assertSame('sent', $this->campaignRow($tenant, $gone)->status);

        $late = $this->createCampaign($h, $store);
        $this->scheduleAt($h, $store, $late, '2026-11-24T09:00:00Z')->assertOk();
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_SUSPENDED]));
        Carbon::setTestNow(Carbon::parse('2026-11-24 09:00:00', 'UTC'));
        $this->artisan('campaigns:dispatch-due')->assertSuccessful();
        $this->assertSame(['failed', 'store_unavailable'], [$this->campaignRow($tenant, $late)->status, $this->campaignRow($tenant, $late)->failure_reason]);
        $this->assertCount(3, $this->sms()->sent, 'only the $gone campaign sent');
    }

    public function test_provider_failure_marks_the_recipient_failed_without_retry(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $this->customer($h, $store);
        $this->sms()->failNext = true;
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $rows = $this->recipientsOf($tenant, $id);
        $this->assertSame(['failed', 'sent'], $rows->pluck('status')->all());
        $this->assertSame('provider_error', $rows[0]->error_code);
        $this->assertSame([1, 1], [$this->campaignRow($tenant, $id)->sent_count, $this->campaignRow($tenant, $id)->failed_count]);
        $this->assertCount(1, $this->sms()->sent);
        $this->assertSame(['failed', 'sent'], $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'campaign')->orderBy('id')->pluck('status')->sort()->values()->all());
    }

    public function test_recipients_are_pruned_after_thirteen_months_and_counters_kept(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $karim = $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$karim->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();
        Carbon::setTestNow(now()->addMonths(13)->addDay());
        $this->artisan('campaigns:prune-recipients')->assertSuccessful();
        $this->assertSame(0, $this->recipientsOf($tenant, $id)->count());
        $campaign = $this->campaignRow($tenant, $id);
        $this->assertSame([1, 1], [$campaign->recipients_count, $campaign->sent_count]);
        $this->assertSame(1, $this->platformQuery(MarketingSuppression::class)->where('tenant_id', $tenant->id)->count(), 'suppressions kept forever');
        $this->api($h, 'GET', $this->cUrl($store, "/{$id}"))->assertOk()->assertJsonPath('data.stats.sent', 1);
    }

    private function runBatches(Tenant $tenant): void
    {
        foreach (Queue::pushed(SendCampaignBatch::class) as $job) {
            $this->inTenant($tenant, fn () => $job->handle(app(CampaignPipeline::class)));
        }
    }
}
