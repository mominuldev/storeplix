<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-5 §4 consent + opt-out: the storefront unsubscribe API (S116, S117), test codes, the customer-owned rule
 * (S118: DELETE 409, PATCH accepts_marketing and CSV import keep the suppression), the merchant toggle + audit (S126),
 * and `Customer.marketing`.
 */
#[Group('campaigns')]
#[Group('security')]
class UnsubscribeTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpCampaigns(throttles: true); // the S116 limiter test needs them; every other call stays far below
    }

    /** Sends one SMS campaign to one customer; returns [customer, code, campaign id]. @return array{0: Customer, 1: string, 2: string} */
    private function sentTo(array $h, Store $store, array $attributes = []): array
    {
        $customer = $this->customer($h, $store, $attributes);
        $id = $this->createCampaign($h, $store);
        $this->sendNow($h, $store, $id)->assertStatus(202);
        $last = end($this->sms()->sent);

        return [$customer, $this->codeIn($last['text']), $id];
    }

    public function test_get_shows_status_and_never_changes_state_post_is_idempotent(): void
    {
        [, $tenant, $store, $h] = $this->campaignShop();
        [$customer, $code, $id] = $this->sentTo($h, $store);

        $get = $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->assertSame(['channel' => 'sms', 'masked_address' => '+880 17•• •••'.substr($customer->phone, -3), 'status' => 'subscribed', 'is_test' => false, 'store_name' => $store->name], $get->json('data'));
        $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk();
        $this->assertSame(0, $this->suppressions($tenant)->count(), 'GET never unsubscribes (link scanners)');

        foreach ([1, 2] as $i) {
            $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk()->assertJsonPath('data.status', 'unsubscribed');
        }
        $rows = $this->suppressions($tenant)->get();
        $this->assertCount(1, $rows);
        $this->assertSame(['sms', $customer->phone, 'link', $id], [$rows[0]->channel, $rows[0]->address, $rows[0]->source, $rows[0]->campaign_id]);
        $this->assertTrue($this->inTenant($tenant, fn () => Customer::query()->find($customer->id))->accepts_marketing, 'P85-QA-4: per channel only');
        $this->assertNotNull($this->recipientsOf($tenant, $id)->first()->unsubscribed_at);
        $this->assertSame(1, $this->campaignRow($tenant, $id)->unsubscribed_count);
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', '%unsubscrib%')->count(), 'shopper action: not audited');

        // Subscribe again (customer-owned rows only) and the merchant view follows.
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer->id}")->assertJsonPath('data.marketing.sms', 'unsubscribed')
            ->assertJsonPath('data.marketing.unsubscribed_source', ['sms' => 'link', 'email' => null])
            ->assertJsonPath('data.marketing.unsubscribed_sms_at', '2026-11-24T06:00:00Z');
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'resubscribe'])->assertOk()->assertJsonPath('data.status', 'subscribed');
        $this->assertSame(0, $this->suppressions($tenant)->count());
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'stop'])->assertStatus(422);
    }

    public function test_unknown_and_malformed_codes_answer_the_same_404(): void
    {
        [, , $store] = $this->campaignShop();
        $bodies = [];
        foreach (['AbCdEfGh12', 'short', 'way-too-long-code-!!', 'AbCdEfGh1%'] as $code) {
            foreach (['GET', 'POST'] as $method) {
                $res = $this->sf($store, $method, '/unsubscribe/'.rawurlencode($code), ['action' => 'unsubscribe'])->assertNotFound();
                $bodies[] = $res->getContent();
            }
        }
        $this->assertCount(1, array_unique($bodies));
        $this->assertSame('unsubscribe_link_invalid', json_decode($bodies[0], true)['error']['code']);
    }

    public function test_a_code_of_store_a_on_store_b_host_is_unknown(): void
    {
        // S117
        [, $tenantA, $storeA, $hA] = $this->campaignShop(slug: 'alpha');
        [, , $storeB] = $this->campaignShop(slug: 'beta');
        [, $code] = $this->sentTo($hA, $storeA);
        $this->sf($storeB, 'GET', "/unsubscribe/{$code}")->assertNotFound()->assertJsonPath('error.code', 'unsubscribe_link_invalid');
        $this->sf($storeB, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertNotFound();
        $this->assertSame(0, $this->suppressions($tenantA)->count());
        $this->sf($storeA, 'GET', "/unsubscribe/{$code}")->assertOk();
    }

    public function test_draft_store_still_answers_and_unsubscribe_is_rate_limited(): void
    {
        // S116 limiter: 20 / min per shopper IP; §8.6: reachable while the store is in draft.
        [, $tenant, $store, $h] = $this->campaignShop();
        [, $code] = $this->sentTo($h, $store);
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.7'];
        for ($i = 1; $i <= 20; $i++) {
            $this->sf($store, 'GET', "/unsubscribe/{$code}", [], null, $ip)->assertOk();
        }
        $this->sf($store, 'GET', "/unsubscribe/{$code}", [], null, $ip)->assertStatus(429);
        $this->sf($store, 'GET', "/unsubscribe/{$code}", [], null, ['X-Storefront-Client-Ip' => '198.51.100.8'])->assertOk();
    }

    public function test_test_codes_say_so_and_change_nothing(): void
    {
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        $owner->forceFill(['phone' => '8801911000111', 'phone_verified_at' => now()])->save();
        $id = $this->createCampaign($h, $store);
        $this->api($h, 'POST', $this->cUrl($store, "/{$id}/test"))->assertStatus(202);
        $code = $this->codeIn($this->sms()->sent[0]['text']);
        // Test codes never expire (§4.2, §9.1).
        $this->travel(400)->days();
        $this->sf($store, 'GET', "/unsubscribe/{$code}")->assertOk()
            ->assertJsonPath('data.is_test', true)->assertJsonPath('data.masked_address', '+880 19•• •••111')->assertJsonPath('data.status', 'subscribed');
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk()->assertJsonPath('data.is_test', true);
        $this->assertSame(0, $this->suppressions($tenant)->count());
    }

    public function test_merchant_cannot_clear_a_customer_owned_suppression(): void
    {
        // S118
        Storage::fake('local');
        config(['storeplix.bulk_per_hour' => 1000]);
        [, $tenant, $store, $h] = $this->campaignShop();
        [$customer, $code] = $this->sentTo($h, $store, ['phone' => '01711111111']);
        $this->sf($store, 'POST', "/unsubscribe/{$code}", ['action' => 'unsubscribe'])->assertOk();

        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out/sms")
            ->assertStatus(409)->assertJsonPath('error.code', 'suppression_customer_owned');
        $rev = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer->id}")->json('data.revision');
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/customers/{$customer->id}", ['accepts_marketing' => true, 'revision' => $rev])->assertOk()
            ->assertJsonPath('data.accepts_marketing', true)->assertJsonPath('data.marketing.sms', 'unsubscribed');
        // A merchant toggle on top keeps the customer's own row.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk()
            ->assertJsonPath('data.unsubscribed_source.sms', 'link');

        // CSV re-import with "Accepts marketing = yes".
        $import = $this->flushHeaders()->withHeaders($h)->post("/api/v1/stores/{$store->id}/imports", [
            'type' => 'customers', 'file' => UploadedFile::fake()->createWithContent('c.csv', "Name,Phone,Accepts marketing\nRe Import,01711111111,yes\n"),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data');
        $validated = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/validate", [
            'column_map' => $import['suggested_map'], 'options' => ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true],
        ])->assertStatus(202)->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$validated['id']}/run")->assertStatus(202);

        $this->assertSame(1, $this->suppressions($tenant)->where('source', 'link')->count());
        $this->api($h, 'POST', $this->cUrl($store, '/audience-preview'), ['channel' => 'sms', 'audience' => $this->campaignBody()['audience']])
            ->assertOk()->assertJsonPath('data.recipients', 0)->assertJsonPath('data.excluded.opted_out', 1);
    }

    public function test_merchant_toggle_adds_and_removes_its_own_suppression_and_is_audited(): void
    {
        [$owner, $tenant, $store, $h] = $this->campaignShop();
        $customer = $this->customer($h, $store, ['email' => 'Karim@Example.com']);
        $url = "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out";

        $data = $this->api($h, 'POST', $url, ['channel' => 'email'])->assertOk()->json('data');
        $this->assertSame(['sms' => 'subscribed', 'email' => 'unsubscribed', 'unsubscribed_sms_at' => null, 'unsubscribed_email_at' => '2026-11-24T06:00:00Z', 'unsubscribed_source' => ['sms' => null, 'email' => 'merchant']], $data);
        $this->api($h, 'POST', $url, ['channel' => 'email'])->assertOk();
        $this->assertSame(['karim@example.com'], $this->suppressions($tenant)->pluck('address')->all());
        $this->api($h, 'POST', $url, ['channel' => 'fax'])->assertStatus(422);
        $noEmail = $this->customer($h, $store);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$noEmail->id}/marketing-opt-out", ['channel' => 'email'])->assertStatus(422);

        $this->api($h, 'DELETE', "{$url}/email")->assertOk()->assertJsonPath('data.email', 'subscribed');
        $this->api($h, 'DELETE', "{$url}/email")->assertOk(); // nothing to remove → 200
        $this->api($h, 'DELETE', "{$url}/fax")->assertNotFound();

        $audit = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'customer.marketing%')->orderBy('created_at')->get();
        $this->assertSame(['customer.marketing_opted_out', 'customer.marketing_opted_out', 'customer.marketing_opt_out_removed'], $audit->pluck('action')->all());
        $this->assertSame([$owner->id], $audit->pluck('actor_id')->unique()->values()->all());
        $this->assertSame(['channel' => 'email'], $audit[0]->meta);
    }

    private function suppressions(Tenant $tenant): Builder
    {
        return $this->platformQuery(MarketingSuppression::class)->where('tenant_id', $tenant->id);
    }
}
