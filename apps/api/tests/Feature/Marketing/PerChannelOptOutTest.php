<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Customers\Models\Customer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * P85-QA-4 (PO decision): opt-out is per channel only. An unsubscribe link / one-click writes or removes only that
 * channel's suppression and never touches `accepts_marketing`, so a no-order customer who opted in still gets the
 * other channel, and "Subscribe again" restores the channel (eligibility P85-3 still re-checked at send time).
 */
#[Group('campaigns')]
#[Group('security')]
class PerChannelOptOutTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns();
    }

    private function acceptsMarketing(Customer $customer): bool
    {
        return $this->inTenant($customer->tenant_id, fn () => Customer::query()->findOrFail($customer->id))->accepts_marketing;
    }

    private function sendCampaign(array $h, $store, array $override = []): string
    {
        $id = $this->createCampaign($h, $store, $override);
        $this->sendNow($h, $store, $id)->assertStatus(202);

        return $id;
    }

    public function test_sms_link_opt_out_keeps_email_and_subscribe_again_restores_sms(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $customer = $this->customer($h, $store, ['email' => 'rina@example.com', 'accepts_marketing' => true]);
        $this->assertSame(0, $customer->orders_count, 'fixture: no orders, eligible only through accepts_marketing');

        $this->sendCampaign($h, $store);
        $this->assertCount(1, $this->sms()->sent);
        $code = $this->codeIn($this->sms()->sent[0]['text']);

        // One-click and the page button: only the SMS suppression; accepts_marketing untouched.
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe', 'one_click' => true])->assertOk()->assertJsonPath('data.status', 'unsubscribed');
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk();
        $this->assertTrue($this->acceptsMarketing($customer));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer->id}")->assertOk()
            ->assertJsonPath('data.accepts_marketing', true)
            ->assertJsonPath('data.marketing.sms', 'unsubscribed')
            ->assertJsonPath('data.marketing.email', 'subscribed');

        // Email campaign still delivered.
        $email = $this->sendCampaign($h, $store, ['channel' => 'email', 'subject' => 'Eid sale']);
        $this->assertCount(1, $this->campaignMails());
        $this->assertSame('rina@example.com', $this->campaignMails()[0]->getOriginalMessage()->getTo()[0]->getAddress());
        $this->assertSame(['sent'], $this->recipientsOf($tenant, $email)->pluck('status')->all());

        // SMS campaign: nobody left.
        $blocked = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $blocked)->assertStatus(422)->assertJsonPath('error.code', 'campaign_no_recipients');
        $this->assertCount(1, $this->sms()->sent);

        // Subscribe again → SMS delivered again.
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'resubscribe'])->assertOk()->assertJsonPath('data.status', 'subscribed');
        $this->assertTrue($this->acceptsMarketing($customer));
        $again = $this->sendCampaign($h, $store);
        $this->assertCount(2, $this->sms()->sent);
        $this->assertSame(['sent'], $this->recipientsOf($tenant, $again)->pluck('status')->all());
        $this->assertTrue($this->acceptsMarketing($customer));
    }

    public function test_email_link_opt_out_keeps_sms(): void
    {
        [, , $store, $h] = $this->campaignShop();
        $customer = $this->customer($h, $store, ['email' => 'nila@example.com', 'accepts_marketing' => true]);
        $this->sendCampaign($h, $store, ['channel' => 'email', 'subject' => 'Hello']);
        $unsub = $this->campaignMails()[0]->getOriginalMessage()->getHeaders()->get('List-Unsubscribe')->getBodyAsString();
        $this->sf($store, 'POST', '/unsubscribe/'.$this->codeIn($unsub), ['action' => 'unsubscribe', 'one_click' => true])->assertOk();

        $this->assertTrue($this->acceptsMarketing($customer));
        $this->sendCampaign($h, $store);
        $this->assertSame([$customer->phone], array_column($this->sms()->sent, 'to'));
    }

    public function test_merchant_toggle_is_per_channel_and_eligibility_is_still_checked_at_send_time(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        $customer = $this->customer($h, $store, ['email' => 'mita@example.com', 'accepts_marketing' => true]);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk()
            ->assertJsonPath('data.sms', 'unsubscribed')->assertJsonPath('data.email', 'subscribed');
        $this->assertTrue($this->acceptsMarketing($customer));
        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out/sms")->assertOk()
            ->assertJsonPath('data.sms', 'subscribed');

        // Eligibility (P85-3) is a property of the customer, re-checked per recipient: the merchant clears consent after
        // the snapshot → the next send skips the customer as not_eligible.
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/customers/{$customer->id}", ['accepts_marketing' => false, 'revision' => $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer->id}")->json('data.revision')])->assertOk();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer->id}")->assertJsonPath('data.marketing.sms', 'not_eligible')
            ->assertJsonPath('data.marketing.email', 'not_eligible');
    }
}
