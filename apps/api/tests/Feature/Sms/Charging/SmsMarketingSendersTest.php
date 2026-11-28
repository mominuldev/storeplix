<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Billing\Models\Plan;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Sms\Models\SmsMessage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Automations\AutomationFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9A §4.3 for campaigns and automations: schedule/send fit = remaining + credits; per recipient the log row is
 * charged before the provider call (allowance, else credits; skipped → recipient `plan`); automation steps skip with
 * `allowance`; credit-paid rows never count against the campaign allowance.
 */
#[Group('sms')]
class SmsMarketingSendersTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase, SmsChargingFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_campaign_beyond_the_allowance_is_paid_with_credits_then_skipped_as_plan(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->smsPlan($tenant, Plan::STARTER, 2000, 1);
        $this->customer($h, $store);
        $this->customer($h, $store);
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached'); // 3 parts, 1 left, 0 credits

        $this->giveCredits($tenant, 2);
        $this->api($h, 'POST', $this->cUrl($store, '/estimate'), ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi {name}', 'audience' => $this->campaignBody()['audience']])
            ->assertOk()->assertJsonPath('data.allowance.credits', 2);
        $this->sendNow($h, $store, $id)->assertStatus(202);

        $recipients = $this->recipientsOf($tenant, $id);
        $this->assertSame(['allowance', 'credits', 'credits'], $recipients->pluck('charged_from')->all());
        $this->assertSame(0, $this->balance($tenant));
        $this->assertCount(3, $this->sms()->sent);
        $rows = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'campaign')->orderBy('id')->get();
        $this->assertSame(['sent', 'sent', 'sent'], $rows->pluck('status')->all());
        $this->assertSame(['campaign'], $rows->pluck('reference_type')->unique()->values()->all());
        $this->assertSame(1, $this->inTenant($tenant, fn () => CampaignAllowance::used('sms')), 'credit-paid recipients do not count');
        $this->assertLedgerMatches($tenant);

        // Nothing left: the next campaign's recipients are skipped (`plan`) without a provider call.
        $this->customer($h, $store);
        $second = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $second)->assertStatus(402);
    }

    public function test_free_plan_campaigns_and_automations_never_use_credits(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop(Plan::FREE);
        $this->giveCredits($tenant, 100);
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(402);
        $this->assertSame(100, $this->balance($tenant));
    }

    public function test_automation_steps_use_credits_then_skip_with_allowance(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        $this->smsPlan($tenant, Plan::STARTER, 2000, 1);
        $this->giveCredits($tenant, 1);
        $this->automationOn($h, $store, 'thank_you', ['message' => ['language' => 'en', 'body' => 'Thanks {name}!']]);
        $this->deliveredOrder($h, $store, $variant);
        $this->deliveredOrder($h, $store, $variant, ['contact' => ['name' => 'Other Buyer', 'phone' => '01822000999']]);
        $this->deliveredOrder($h, $store, $variant, ['contact' => ['name' => 'Third Buyer', 'phone' => '01822000888']]);

        $steps = $this->platformQuery(AutomationRunStep::class)->where('tenant_id', $tenant->id)->orderBy('created_at')->orderBy('id')->get();
        $this->assertSame([['done', null, 'allowance'], ['done', null, 'credits'], ['skipped', 'allowance', null]],
            $steps->map(fn ($s) => [$s->status, $s->reason, $s->charged_from])->all());
        $this->assertCount(2, $this->sms()->sent);
        $this->assertSame(0, $this->balance($tenant));
        $skipped = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'automation')->where('status', 'skipped')->sole();
        $this->assertSame(['no_credits', 'automation'], [$skipped->error_code, $skipped->reference_type]);
        $this->assertLedgerMatches($tenant);
    }
}
