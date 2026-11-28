<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Billing\Models\Subscription;
use App\Domain\Sms\Broadcasts\Jobs\SendPlatformBroadcastBatch;
use App\Domain\Sms\Broadcasts\Jobs\StartPlatformBroadcast;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsGateway;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Bus;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §7 (P89B-17 – P89B-22, S228): drafts, audiences, estimate numbers, sending hours (08:59 / 09:00 / 20:59 /
 * 21:00 Dhaka), typed count 409, balance 422, empty audience 422, mask not approved 409, switch off 409, send now with the
 * STOP link, suspended / unverified / opted-out / duplicate / weekly cap skips, opt-out between schedule and send, pause
 * at 21:00 + resume, cancel, counters, recipients list.
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class PlatformSmsBroadcastsTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    private string $provider;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
        $this->travelTo(Carbon::parse('2026-12-01 10:00', 'Asia/Dhaka'));
        $this->reveOk();
        $this->provider = $this->activeProvider($this->reveInput());
    }

    /** @param array<string, mixed> $over */
    private function body(array $over = []): array
    {
        return array_replace([
            'name' => 'December offer',
            'body_bn' => '{merchant_name}, ডিসেম্বর অফার: {plan} প্ল্যানে ২০% ছাড়। {link}',
            'body_en' => '{merchant_name}, December offer: 20% off {plan}. {link}',
            'audience' => ['kind' => 'all'],
            'scheduled_at' => null,
        ], $over);
    }

    private function draft(array $over = []): array
    {
        return $this->admin('POST', 'broadcasts', $this->body($over))->assertCreated()->json('data');
    }

    private function schedule(array $b, int $count): TestResponse
    {
        return $this->admin('POST', "broadcasts/{$b['id']}/schedule", ['acknowledged' => true, 'confirm_recipients' => $count, 'revision' => $b['revision']]);
    }

    public function test_drafts_crud_and_validation(): void
    {
        $this->admin('POST', 'broadcasts', $this->body(['body_en' => 'Visit https://x.example {link}']))->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_template_link_not_allowed');
        $this->admin('POST', 'broadcasts', $this->body(['body_en' => 'Hi {invoice_no}']))->assertStatus(422)->assertJsonPath('error.code', 'platform_sms_template_unknown_merge_field');
        $this->admin('POST', 'broadcasts', $this->body(['audience' => ['kind' => 'plan', 'plans' => []]]))->assertStatus(422);
        $this->admin('POST', 'broadcasts', $this->body(['audience' => ['kind' => 'status', 'statuses' => ['nope']]]))->assertStatus(422);
        $this->admin('POST', 'broadcasts', $this->body(['scheduled_at' => '2026-12-01T22:30:00+06:00']))->assertStatus(422)->assertJsonPath('error.code', 'outside_sending_hours');
        $this->admin('POST', 'broadcasts', $this->body(['scheduled_at' => '2026-12-01T10:02:00+06:00']))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->admin('POST', 'broadcasts', $this->body(['scheduled_at' => '2027-01-15T10:00:00+06:00']))->assertStatus(422);

        $b = $this->draft(['audience' => ['kind' => 'plan', 'plans' => ['growth']], 'scheduled_at' => '2026-12-02T09:00:00+06:00']);
        $this->assertSame('draft', $b['status']);
        $this->assertSame('2026-12-02T03:00:00Z', $b['scheduled_at']);
        $this->assertSame(['kind' => 'plan', 'plans' => ['growth']], $b['audience']);
        $this->assertSame($this->super()->id, $b['created_by']['id']);
        $this->admin('GET', "broadcasts/{$b['id']}")->assertOk()->assertJsonPath('data.name', 'December offer');
        $this->admin('PATCH', "broadcasts/{$b['id']}", ['revision' => 5, 'name' => 'XX'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->admin('PATCH', "broadcasts/{$b['id']}", ['revision' => 1, 'name' => 'Renamed', 'scheduled_at' => null])->assertOk()
            ->assertJsonPath('data.name', 'Renamed')->assertJsonPath('data.revision', 2)->assertJsonPath('data.scheduled_at', null);
        $this->admin('GET', 'broadcasts?filter[status]=draft')->assertOk()->assertJsonPath('meta.total', 1)->assertJsonPath('meta.kpis.opted_out_total', 0);
        $this->admin('GET', 'broadcasts?filter[status]=sent')->assertOk()->assertJsonPath('meta.total', 0);
        $this->admin('DELETE', "broadcasts/{$b['id']}")->assertNoContent();
        $this->admin('GET', "broadcasts/{$b['id']}")->assertNotFound();
        foreach (['created', 'updated', 'deleted'] as $action) {
            $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', "platform_sms_broadcast.{$action}")->count(), $action);
        }
    }

    public function test_audiences_and_estimate_with_every_skip_reason(): void
    {
        [$a] = $this->owner('alpha', 'growth');
        [, $b] = $this->owner('beta', 'starter', language: 'en');
        [, $suspended] = $this->owner('gamma', 'growth');
        Tenant::query()->whereKey($suspended->id)->update(['status' => Tenant::STATUS_SUSPENDED]);
        $this->owner('delta', 'growth', verified: false);
        [$out] = $this->owner('epsilon', 'growth');
        $out->forceFill(['platform_promo_sms_opted_out_at' => now(), 'platform_promo_sms_opt_out_source' => 'account'])->save();
        // The same owner owns a second shop: one SMS only.
        [, $second] = $this->owner('zeta', 'growth');
        $this->inTenant($second, fn () => TenantUser::query()->where('tenant_id', $second->id)->update(['user_id' => $a->id]));
        $this->owner('eta', 'growth', 'trialing', trialEnds: now()->addDays(3));

        $this->admin('GET', 'broadcasts/audiences')->assertOk()->assertJsonPath('data.all', 6)
            ->assertJsonPath('data.trial_ending', 1)->assertJsonPath('data.statuses.trialing', 1)->assertJsonPath('data.statuses.active', 5)
            ->assertJsonPath('data.plans.2.code', 'growth')->assertJsonPath('data.plans.2.count', 5);

        $estimate = $this->admin('POST', 'broadcasts/estimate', ['audience' => ['kind' => 'all'], 'body_bn' => $this->body()['body_bn'], 'body_en' => $this->body()['body_en']])
            ->assertOk()->json('data');
        $this->assertSame(3, $estimate['recipients']); // alpha (bn), beta (en), eta (bn)
        $this->assertSame(['suspended' => 1, 'no_verified_phone' => 1, 'opted_out' => 1, 'weekly_cap' => 0, 'duplicate' => 1], $estimate['skipped']);
        $this->assertSame(2 * $estimate['parts_bn'] + $estimate['parts_en'], $estimate['total_parts']);
        $this->assertSame($estimate['total_parts'] * 45, $estimate['cost_paisa']);
        $this->assertSame(250050, $estimate['balance_paisa']);
        $this->assertSame(250050 - $estimate['cost_paisa'], $estimate['balance_after_paisa']);
        $this->assertFalse($estimate['below_alert']); // ৳2,500.50 minus the cost stays above the ৳1,000 threshold
        $this->assertSame('StorePlixP', $estimate['sender_id']);
        $this->assertSame(['sending_hours' => true, 'stop_footer' => true, 'opt_outs_honoured' => true, 'weekly_cap' => 2], $estimate['checks']);
    }

    public function test_send_now_renders_the_stop_link_and_counts(): void
    {
        [$a] = $this->owner('alpha', 'growth');
        [$b] = $this->owner('beta', 'starter', language: 'en');
        $draft = $this->draft();
        $this->schedule($draft, 5)->assertStatus(409)->assertJsonPath('error.code', 'broadcast_estimate_changed')->assertJsonPath('error.details.recipients', 2);
        $this->admin('POST', "broadcasts/{$draft['id']}/schedule", ['acknowledged' => false, 'confirm_recipients' => 2, 'revision' => 1])->assertStatus(422);
        $sent = $this->schedule($draft, 2)->assertOk()->json('data');
        $this->assertSame('sent', $sent['status']); // sync queue: started and finished
        $this->assertSame(['recipients' => 2, 'sent' => 2, 'failed' => 0, 'skipped' => 0, 'pending' => 0], $sent['counts']);
        $this->assertSame(2, $sent['estimate']['recipients']);
        $texts = collect($this->fake()->sent)->pluck('text', 'to');
        $this->assertMatchesRegularExpression('~^Alpha Owner, ডিসেম্বর অফার: Growth প্ল্যানে ২০% ছাড়। http://localhost:5183/settings/plan বন্ধ করতে: http://localhost:5183/s/[0-9A-Za-z]{10}$~u', $texts[$a->phone]);
        $this->assertMatchesRegularExpression('~^Beta Owner, December offer: 20% off Starter\. http://localhost:5183/settings/plan STOP: http://localhost:5183/s/[0-9A-Za-z]{10}$~', $texts[$b->phone]);
        $this->assertSame(['promotional', 'promotional'], array_slice($this->fake()->routes, -2));
        $rows = $this->platformQuery(SmsMessage::class)->where('purpose', 'platform_broadcast')->get();
        $this->assertCount(2, $rows);
        $this->assertNull($rows[0]->tenant_id);
        $this->assertStringEndsWith('STOP: [link]', (string) $rows->firstWhere('to', $b->phone)->body_preview);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms_broadcast.finished')->count());

        // Opt-out code: works once per recipient, stored as sha256 only.
        preg_match('~/s/([0-9A-Za-z]{10})$~', $texts[$b->phone], $m);
        $this->assertSame(1, $this->platformTable('platform_sms_broadcast_recipients')->where('opt_out_code_hash', hash('sha256', $m[1]))->count());
        $this->getJson("/api/v1/platform-sms/opt-out/{$m[1]}")->assertOk()->assertJsonPath('data.status', 'subscribed');

        // The recipients list.
        $this->admin('GET', "broadcasts/{$draft['id']}/recipients")->assertOk()->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.status', 'sent')->assertJsonPath('meta.next_cursor', null);
        $this->admin('GET', "broadcasts/{$draft['id']}/recipients?filter[status]=skipped")->assertOk()->assertJsonCount(0, 'data');

        // Scheduling twice: 409 (the row is no longer a draft).
        $this->schedule($sent, 2)->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->admin('GET', 'broadcasts')->assertJsonPath('meta.kpis.broadcasts_this_month', 1)->assertJsonPath('meta.kpis.sent_success_rate', 100);
    }

    public function test_schedule_guards(): void
    {
        $draft = $this->draft();
        $this->schedule($draft, 0)->assertStatus(422)->assertJsonPath('error.code', 'broadcast_empty_audience');
        $this->owner('alpha');
        // Switch off → 409.
        $this->admin('PATCH', 'message-types/broadcast', ['enabled' => false])->assertOk();
        $this->schedule($draft, 1)->assertStatus(409)->assertJsonPath('error.code', 'platform_sms_type_disabled');
        $this->admin('PATCH', 'message-types/broadcast', ['enabled' => true])->assertOk();
        // Mask pending → 409.
        $rev = $this->provider($this->provider)->revision;
        $this->admin('PATCH', "providers/{$this->provider}", ['revision' => $rev, 'promotional_sender_status' => 'pending'])->assertOk();
        $this->schedule($draft, 1)->assertStatus(409)->assertJsonPath('error.code', 'promotional_sender_not_approved');
        $this->admin('PATCH', "providers/{$this->provider}", ['revision' => $rev + 1, 'promotional_sender_status' => 'approved'])->assertOk();
        // Balance too low → 422.
        $this->platformTable('sms_providers')->where('id', $this->provider)->update(['balance_amount' => 10]);
        SmsRoutingTable::flush();
        $this->schedule($draft, 1)->assertStatus(422)->assertJsonPath('error.code', 'gateway_balance_insufficient')->assertJsonPath('error.details.balance_paisa', 10);
        $this->platformTable('sms_providers')->where('id', $this->provider)->update(['balance_amount' => 900000]);
        // Outside sending hours → 422 for "send now".
        $this->travelTo(Carbon::parse('2026-12-01 21:00', 'Asia/Dhaka'));
        $this->schedule($draft, 1)->assertStatus(422)->assertJsonPath('error.code', 'outside_sending_hours');
        $this->travelTo(Carbon::parse('2026-12-02 08:59', 'Asia/Dhaka'));
        $this->schedule($draft, 1)->assertStatus(422)->assertJsonPath('error.code', 'outside_sending_hours');
        $this->travelTo(Carbon::parse('2026-12-02 20:59', 'Asia/Dhaka'));
        Bus::fake([StartPlatformBroadcast::class]);
        $this->schedule($draft, 1)->assertOk()->assertJsonPath('data.status', 'sending');
        Bus::assertDispatched(StartPlatformBroadcast::class);
    }

    public function test_scheduled_run_cancel_and_opt_out_between_schedule_and_send(): void
    {
        [$a] = $this->owner('alpha');
        $this->owner('beta');
        $at = Carbon::parse('2026-12-01 09:00', 'Asia/Dhaka')->addDay();
        $draft = $this->draft(['scheduled_at' => $at->toIso8601String()]);
        $scheduled = $this->schedule($draft, 2)->assertOk()->assertJsonPath('data.status', 'scheduled')->json('data');
        $this->artisan('sms:run-broadcasts')->assertExitCode(0);
        $this->assertSame('scheduled', $this->admin('GET', "broadcasts/{$draft['id']}")->json('data.status')); // not due yet

        // The owner opts out in between: skipped at send time.
        $this->flushSession()->flushHeaders()->withHeaders(['X-Testing-User' => $a->id])->patchJson('/api/v1/account/sms-preferences', ['promotional' => false])->assertOk();
        $this->travelTo($at);
        $this->artisan('sms:run-broadcasts')->assertExitCode(0);
        $done = $this->admin('GET', "broadcasts/{$draft['id']}")->assertOk()->json('data');
        $this->assertSame('sent', $done['status']);
        $this->assertSame(['recipients' => 2, 'sent' => 1, 'failed' => 0, 'skipped' => 1, 'pending' => 0], $done['counts']);
        $this->assertSame('opted_out', $this->admin('GET', "broadcasts/{$draft['id']}/recipients?filter[status]=skipped")->json('data.0.skip_reason'));

        // Cancel only while scheduled.
        $next = $this->draft(['scheduled_at' => $at->copy()->addDay()->toIso8601String()]);
        $this->admin('POST', "broadcasts/{$next['id']}/cancel")->assertStatus(409);
        $this->schedule($next, 1)->assertOk();
        $this->admin('POST', "broadcasts/{$next['id']}/cancel")->assertOk()->assertJsonPath('data.status', 'cancelled');
        $this->admin('POST', "broadcasts/{$scheduled['id']}/cancel")->assertStatus(409);
    }

    public function test_weekly_cap_of_two_per_tenant(): void
    {
        $this->owner('alpha');
        foreach ([1, 2] as $n) {
            $this->schedule($this->draft(['name' => "Offer {$n}"]), 1)->assertOk()->assertJsonPath('data.counts.sent', 1);
        }
        $third = $this->draft(['name' => 'Offer 3']);
        $this->admin('POST', 'broadcasts/estimate', ['audience' => ['kind' => 'all'], 'body_bn' => 'x {link}', 'body_en' => 'y {link}'])
            ->assertJsonPath('data.recipients', 0)->assertJsonPath('data.skipped.weekly_cap', 1);
        $this->schedule($third, 0)->assertStatus(422)->assertJsonPath('error.code', 'broadcast_empty_audience');
        $this->travel(8)->days();
        $this->travelTo(Carbon::parse('2026-12-09 10:00', 'Asia/Dhaka'));
        $this->admin('POST', 'broadcasts/estimate', ['audience' => ['kind' => 'all'], 'body_bn' => 'x {link}', 'body_en' => 'y {link}'])->assertJsonPath('data.recipients', 1);
    }

    public function test_a_broadcast_pauses_at_21_and_resumes_at_9(): void
    {
        config(['sms.platform.broadcast_batch' => 1]);
        $this->owner('alpha');
        $this->owner('beta');
        $this->travelTo(Carbon::parse('2026-12-01 20:59', 'Asia/Dhaka'));
        Bus::fake([SendPlatformBroadcastBatch::class]);
        $draft = $this->draft();
        $this->schedule($draft, 2)->assertOk();
        (new StartPlatformBroadcast($draft['id']))->handle();
        (new SendPlatformBroadcastBatch($draft['id']))->handle(app(SmsGateway::class));
        $this->assertCount(1, collect($this->fake()->sent)->filter(fn ($s) => str_contains($s['text'], 'STOP') || str_contains($s['text'], 'বন্ধ')));
        $this->travelTo(Carbon::parse('2026-12-01 21:00', 'Asia/Dhaka'));
        (new SendPlatformBroadcastBatch($draft['id']))->handle(app(SmsGateway::class));
        $this->assertSame('sending', $this->admin('GET', "broadcasts/{$draft['id']}")->json('data.status'));
        $this->assertSame(1, $this->admin('GET', "broadcasts/{$draft['id']}")->json('data.counts.pending'));
        $this->travelTo(Carbon::parse('2026-12-02 09:00', 'Asia/Dhaka'));
        $this->artisan('sms:run-broadcasts');
        Bus::assertDispatched(SendPlatformBroadcastBatch::class);
        (new SendPlatformBroadcastBatch($draft['id']))->handle(app(SmsGateway::class));
        $this->assertSame('sent', $this->admin('GET', "broadcasts/{$draft['id']}")->json('data.status'));
    }

    public function test_broadcast_test_send_uses_the_test_code(): void
    {
        $this->admin('POST', 'broadcasts/test', ['language' => 'en', 'phone' => '01711552211', 'body_bn' => 'x {link}', 'body_en' => 'Hi {merchant_name} {link}'])->assertOk()
            ->assertJsonPath('data.status', 'sent');
        $this->assertSame('Hi Nasrin http://localhost:5183/settings/plan STOP: http://localhost:5183/s/test', $this->fake()->sent[0]['text']);
        $this->assertSame('promotional', $this->fake()->routes[0]);
        $this->getJson('/api/v1/platform-sms/opt-out/test')->assertOk()->assertJsonPath('data.status', 'subscribed');
    }

    public function test_status_audience_and_trial_ending(): void
    {
        $this->owner('alpha', 'growth', Subscription::PAST_DUE);
        $this->owner('beta', 'growth', 'trialing', trialEnds: now()->addDays(10));
        $this->owner('gamma', 'growth', 'trialing', trialEnds: now()->addDays(6));
        $est = fn (array $aud) => $this->admin('POST', 'broadcasts/estimate', ['audience' => $aud, 'body_bn' => 'x {link}', 'body_en' => 'y {link}'])->json('data.recipients');
        $this->assertSame(1, $est(['kind' => 'status', 'statuses' => ['past_due']]));
        $this->assertSame(2, $est(['kind' => 'status', 'statuses' => ['trialing']]));
        $this->assertSame(1, $est(['kind' => 'trial_ending']));
        $this->assertSame(3, $est(['kind' => 'plan', 'plans' => ['growth']]));
        $this->assertSame(0, $est(['kind' => 'plan', 'plans' => ['starter']]));
    }
}
