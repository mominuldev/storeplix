<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Marketing\MarketingServiceProvider;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\TestCase;

/** PHASE-8-5 §5.4 / S125: the dev message sink and the production misconfiguration guard. */
#[Group('campaigns')]
#[Group('security')]
class CampaignDevSinkTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    public function test_the_sink_records_rendered_messages_newest_first_only_when_enabled(): void
    {
        [$owner, , $store, $h] = $this->campaignShop();
        $url = "/api/v1/dev/stores/{$store->id}/message-sink";
        $this->api($h, 'GET', $url)->assertNotFound();

        config(['campaigns.dev_sink' => true]);
        $customer = $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $owner->forceFill(['phone' => '8801911000111', 'phone_verified_at' => now()])->save();
        $draft = $this->createCampaign($h, $store);
        $this->api($h, 'POST', $this->cUrl($store, "/{$draft}/test"))->assertStatus(202);

        $sink = $this->api($h, 'GET', $url)->assertOk()->json('data');
        $this->assertCount(2, $sink);
        $this->assertSame(['channel', 'to', 'subject', 'text', 'unsubscribe_url', 'campaign_id', 'is_test', 'created_at'], array_keys($sink[0]));
        $this->assertTrue($sink[0]['is_test']);
        $this->assertFalse($sink[1]['is_test']);
        $this->assertSame($customer->phone, $sink[1]['to']);
        $this->assertSame($this->sms()->sent[0]['text'], $sink[1]['text']);
        $this->assertSame($draft, $sink[0]['campaign_id']);
        $this->assertStringEndsWith('/u/'.$this->codeIn($sink[1]['text']), $sink[1]['unsubscribe_url']);

        [, $tenant] = [null, $store->tenant_id];
        [, $hs] = $this->memberAs(Tenant::query()->find($tenant), 'staff');
        $this->api($hs, 'GET', $url)->assertForbidden();
    }

    public function test_production_refuses_to_boot_with_the_sink_or_a_log_mailer_and_real_sms(): void
    {
        $this->app['env'] = 'production';
        try {
            config(['campaigns.dev_sink' => true]);
            $this->assertThrows(fn () => MarketingServiceProvider::assertSafeConfiguration($this->app), RuntimeException::class, 'CAMPAIGNS_DEV_SINK');

            config(['campaigns.dev_sink' => false, 'mail.mailers.campaigns.transport' => 'log', 'sms.driver' => 'revesms']);
            $this->assertThrows(fn () => MarketingServiceProvider::assertSafeConfiguration($this->app), RuntimeException::class, 'CAMPAIGN_MAILER');
            config(['mail.mailers.campaigns.transport' => 'array']);
            $this->assertThrows(fn () => MarketingServiceProvider::assertSafeConfiguration($this->app), RuntimeException::class);

            config(['mail.mailers.campaigns.transport' => 'smtp']);
            MarketingServiceProvider::assertSafeConfiguration($this->app);
            $this->assertFalse(DevMessageSink::enabled());
        } finally {
            $this->app['env'] = 'testing';
        }
        // Outside production nothing is enforced.
        config(['campaigns.dev_sink' => true]);
        MarketingServiceProvider::assertSafeConfiguration($this->app);
    }

    public function test_campaign_traffic_never_uses_the_fake_or_log_drivers_in_production(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $this->customer($h, $store);
        $id = $this->createCampaign($h, $store);
        $this->app['env'] = 'production';
        try {
            $this->sendNow($h, $store, $id)->assertStatus(202);
        } finally {
            $this->app['env'] = 'testing';
        }
        $this->assertSame([], $this->sms()->sent);
        $this->assertSame(['failed'], $this->recipientsOf($tenant, $id)->pluck('status')->all());
        $this->assertSame('provider_error', $this->recipientsOf($tenant, $id)->first()->error_code);
    }
}
