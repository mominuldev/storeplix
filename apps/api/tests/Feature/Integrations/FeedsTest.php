<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Feeds\CatalogItemBuilder;
use App\Domain\Feeds\Drivers\FakeFeedDriver;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Integrations\Mail\IntegrationAlertMail;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D §7 product feeds (part A) with the fake feed driver: OAuth state (signed, bound, single use, 10 min) and the
 * callback (S339), account choice, item mapping + inclusion (P89D-27/28, S340), full / delta / manual sync and content
 * hashes (P89D-29), issues + Needs attention (P89D-30), website claim steps (P89D-32), disconnect (P89D-31), plan
 * gates, token refresh / expiry (P89D-26).
 */
#[Group('integrations')]
#[Group('feeds')]
class FeedsTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
        Storage::fake('public');
        Storage::fake('local');
    }

    /** A Starter shop with one image. @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string} */
    private function feedShop(string $slug = 'feeds'): array
    {
        [, $tenant, $store, $h] = $this->liveShop($slug);
        $this->planFor($tenant, 'starter');

        return [$tenant, $store, $h, $this->productImage($h)];
    }

    /** @return array<string, mixed> created product */
    private function product(array $h, Store $store, string $name, ?string $image, array $extra = [], array $variant = []): array
    {
        return $this->createProduct($h, $store, $this->simpleProduct($name, 120000, $extra + ['status' => 'active'] + ($image !== null ? ['images' => [['media_id' => $image]]] : []),
            $variant + ['initial_on_hand' => 5]));
    }

    #[Group('security')]
    public function test_oauth_state_is_signed_bound_single_use_and_expires(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('oauth');
        $this->planFor($tenant, 'starter');
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/oauth/start'))->assertNotFound();
        $start = $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/oauth/start'))->assertOk()->json('data');
        $query = [];
        parse_str((string) parse_url($start['authorize_url'], PHP_URL_QUERY), $query);
        $this->assertSame('fake-code', $query['code']);

        // Tampered / missing state → plain 400 page; nothing created.
        $this->oauthCallback('meta_catalog', ['code' => 'fake-code', 'state' => $query['state'].'x'])->assertStatus(400)->assertHeader('Referrer-Policy', 'no-referrer');
        $this->oauthCallback('meta_catalog', ['code' => 'fake-code'])->assertStatus(400);
        // Bound to the provider.
        $this->assertStringEndsWith('oauth=error&reason=state_invalid', (string) $this->oauthCallback('google_merchant', $query)->assertStatus(303)->headers->get('Location'));

        $ok = $this->oauthCallback('meta_catalog', $query)->assertStatus(303);
        $this->assertSame('http://localhost:5183/integrations/meta-catalog?oauth=success', $ok->headers->get('Location'));
        $row = $this->integrationRow($tenant, $store, 'meta_catalog');
        $this->assertSame('setup_required', $row->status);
        $this->assertStringStartsWith('fake-access-', $row->secrets()['access_token']);
        $this->assertStringNotContainsString($row->secrets()['access_token'], (string) $this->platformTable('store_integrations')->where('id', $row->id)->value('credentials'));
        $this->assertSame([], (array) $row->credentials_hint);
        $show = $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog'))->assertOk();
        $this->assertStringNotContainsString($row->secrets()['access_token'], $show->getContent());
        $this->assertStringNotContainsString($row->secrets()['refresh_token'], $show->getContent());
        $this->assertNotNull($show->json('data.token_expires_at'));

        // Single use: the same state again is refused.
        $this->assertStringContainsString('reason=state_invalid', (string) $this->oauthCallback('meta_catalog', $query)->headers->get('Location'));

        // Expiry (10 minutes).
        $start = $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/oauth/start'))->json('data.authorize_url');
        parse_str((string) parse_url($start, PHP_URL_QUERY), $query);
        $this->travel(11)->minutes();
        $this->assertStringContainsString('reason=state_invalid', (string) $this->oauthCallback('meta_catalog', $query)->headers->get('Location'));
        $this->travelBack();

        // Provider error / refused exchange.
        foreach ([['error' => 'access_denied', 'reason' => 'denied'], ['code' => 'fake-fail', 'reason' => 'exchange_failed']] as $case) {
            $url = $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/oauth/start'))->json('data.authorize_url');
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            $reason = $case['reason'];
            unset($case['reason'], $q['code']);
            $this->assertStringEndsWith('reason='.$reason, (string) $this->oauthCallback('meta_catalog', $q + $case)->headers->get('Location'));
        }

        // A member who lost integrations.manage meanwhile can't finish the flow.
        [$admin, $ha] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $url = $this->api($ha, 'POST', $this->intUrl($store, '/google_merchant/oauth/start'))->json('data.authorize_url');
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
        $this->platformTable('tenant_users')->where('user_id', $admin->id)->update(['role' => 'staff']);
        $this->assertStringContainsString('reason=state_invalid', (string) $this->oauthCallback('google_merchant', $q)->headers->get('Location'));
        $this->assertNull($this->integrationRow($tenant, $store, 'google_merchant'));
        $this->assertSame(['integration.oauth_connected'], array_column($this->audits($tenant), 'action'));
    }

    public function test_accounts_choice_first_sync_mapping_inclusion_and_isolation(): void
    {
        [$tenant, $store, $h, $img] = $this->feedShop('mapping');
        [, $tenantB, $storeB, $hB] = $this->liveShop('otherfeed');
        $this->planFor($tenantB, 'starter');
        $imgB = $this->productImage($hB);
        $this->product($hB, $storeB, 'Store B Saree', $imgB);

        $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/accounts'))->assertStatus(409)->assertJsonPath('error.code', 'integration_setup_required');
        $live = $this->product($h, $store, 'Cotton Panjabi', $img, [], ['compare_at_amount' => 150000]);
        $draft = $this->product($h, $store, 'Draft Kurti', $img, ['status' => 'draft']);
        $noImage = $this->product($h, $store, 'No Image Shirt', null);
        $soldOut = $this->product($h, $store, 'Sold Out Scarf', $img, [], ['initial_on_hand' => 0]);
        $this->oauth($h, $store);
        $this->assertSame(['100200300', '100200301'], array_column($this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/accounts'))->assertOk()->json('data'), 'id'));
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['account_id' => '999'])->assertJsonValidationErrors(['account_id'], 'error.details');
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), [])->assertJsonValidationErrors(['account_id'], 'error.details');
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['account_id' => '<x>'])->assertJsonValidationErrors(['account_id'], 'error.details');

        $d = $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['account_id' => '100200300'])->assertOk()->json('data');
        $this->assertSame(['connected', '100200300', 'Storeplix test catalog'], [$d['status'], $d['settings']['catalog_id'], $d['settings']['catalog_name']]);
        $integration = $this->integrationRow($tenant, $store, 'meta_catalog');
        $items = $this->catalogItems($tenant, $integration->id)->keyBy('product_id');
        $this->assertSame(['synced', null], [$items[$live['id']]->status, $items[$live['id']]->excluded_reason]);
        $this->assertSame(['excluded', 'not_published'], [$items[$draft['id']]->status, $items[$draft['id']]->excluded_reason]);
        $this->assertSame(['excluded', 'no_image'], [$items[$noImage['id']]->status, $items[$noImage['id']]->excluded_reason]);
        $this->assertSame('synced', $items[$soldOut['id']]->status); // sent as out of stock unless hide_sold_out
        $this->assertSame('approved', $items[$live['id']]->review_status);
        $this->assertSame(64, strlen((string) $items[$live['id']]->content_hash));
        // S340: the fake provider holds only this store's included variants.
        $this->assertEqualsCanonicalizing([$live['variants'][0]['id'], $soldOut['variants'][0]['id']], FakeFeedDriver::$held[$integration->id]);
        $this->assertSame(0, $this->catalogItems($tenantB)->count());

        $run = $this->syncRuns($tenant)->last();
        $this->assertSame(['full', 'connect', 'done', 2, 0], [$run->kind, $run->trigger, $run->status, $run->items_sent, $run->items_failed]);
        $overview = $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/feed'))->assertOk()->json('data');
        $this->assertSame(['total' => 2, 'approved' => 2, 'in_review' => 0, 'with_issues' => 0, 'not_sent' => 2], $overview['counts']);
        $this->assertSame('done', $overview['last_run']['status']);
        $this->assertSame('2 of 2 products live', collect($this->api($h, 'GET', $this->intUrl($store))->json('data'))->firstWhere('provider', 'meta_catalog')['summary']);

        $list = $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/items?status=excluded'))->assertOk();
        $this->assertCount(2, $list->json('data'));
        $this->assertSame(['id', 'product', 'variant', 'status', 'review_status', 'excluded_reason', 'issues', 'last_synced_at'], array_keys($list->json('data.0')));
        $this->assertSame(2, $list->json('meta.counts.not_sent'));
        $this->assertCount(1, $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/items?q=panjabi'))->json('data'));
        $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/items?status=gone'))->assertJsonValidationErrors(['status'], 'error.details');
        $this->assertCount(1, $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/sync-runs'))->assertOk()->json('data'));

        // Settings: hide sold out + categories of this store only.
        $this->api($h, 'PATCH', $this->intUrl($store, '/meta_catalog'), ['settings' => ['include' => 'categories', 'category_ids' => [strtolower((string) Str::ulid())]], 'revision' => $integration->revision])
            ->assertJsonValidationErrors(['settings.category_ids'], 'error.details');
        $this->api($h, 'PATCH', $this->intUrl($store, '/meta_catalog'), ['settings' => ['hide_sold_out' => true, 'default_brand' => '<b>Deshi</b>'], 'revision' => $integration->revision])
            ->assertOk()->assertJsonPath('data.settings.default_brand', 'Deshi');
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();
        $item = $this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $soldOut['id']);
        $this->assertSame(['excluded', 'sold_out_hidden'], [$item->status, $item->excluded_reason]);
        $this->assertSame([$live['variants'][0]['id']], FakeFeedDriver::$held[$integration->id]);
    }

    public function test_item_mapping_values(): void
    {
        [$tenant, $store, $h, $img] = $this->feedShop('values');
        $p = $this->product($h, $store, 'Jamdani Saree', $img, ['description' => ['type' => 'doc', 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Hand woven '],
            ['type' => 'text', 'text' => 'Dhakai', 'marks' => [['type' => 'bold']]]]]]]], ['compare_at_amount' => 150000]);
        $this->connectFeed($h, $store, 'google_merchant');
        $integration = $this->integrationRow($tenant, $store, 'google_merchant');
        $built = $this->inTenant($tenant, fn () => CatalogItemBuilder::build(Store::query()->findOrFail($store->id), $integration));
        $data = $built[$p['variants'][0]['id']]['data'];
        $this->assertSame([
            'id' => $p['variants'][0]['id'], 'item_group_id' => $p['id'], 'title' => 'Jamdani Saree', 'description' => 'Hand woven Dhakai',
            'link' => 'https://'.$this->host($store).'/products/'.$p['slug'].'?variant='.$p['variants'][0]['id'],
            'price_amount' => 150000, 'sale_price_amount' => 120000, 'currency' => 'BDT', 'availability' => 'in stock', 'brand' => $store->name,
            'condition' => 'new', 'language' => 'bn', 'country' => 'BD', 'identifier_exists' => 'no',
        ], array_diff_key($data, ['image_link' => 1, 'additional_image_links' => 1]));
        $this->assertStringStartsWith('http', $data['image_link']);
        // Deterministic content hash; a setting change (sale price off) changes it.
        $again = $this->inTenant($tenant, fn () => CatalogItemBuilder::build(Store::query()->findOrFail($store->id), $integration));
        $this->assertSame($built[$p['variants'][0]['id']]['hash'], $again[$p['variants'][0]['id']]['hash']);
        $integration->settings = ['use_sale_price' => false, 'condition' => 'used', 'feed_language' => 'en'] + $integration->settings;
        $other = $this->inTenant($tenant, fn () => CatalogItemBuilder::build(Store::query()->findOrFail($store->id), $integration))[$p['variants'][0]['id']];
        $this->assertSame([120000, null, 'used', 'en'], [$other['data']['price_amount'], $other['data']['sale_price_amount'], $other['data']['condition'], $other['data']['language']]);
        $this->assertNotSame($built[$p['variants'][0]['id']]['hash'], $other['hash']);
    }

    public function test_deltas_hourly_full_sync_manual_sync_deletes_and_issues(): void
    {
        [$tenant, $store, $h, $img] = $this->feedShop('deltas');
        $a = $this->product($h, $store, 'Linen Shirt', $img);
        $b = $this->product($h, $store, 'Silk Tie', $img);
        $this->connectFeed($h, $store);
        $integration = $this->integrationRow($tenant, $store, 'meta_catalog');
        $base = "/api/v1/stores/{$store->id}/products";

        // Hourly full sync: unchanged items are skipped by hash.
        $this->artisan('feeds:sync', ['--sync' => true])->assertSuccessful();
        $run = $this->syncRuns($tenant)->last();
        $this->assertSame(['full', 'schedule', 'done', 0], [$run->kind, $run->trigger, $run->status, $run->items_sent]);

        // A price change marks the item dirty; the 5-minute delta pushes only it.
        $this->api($h, 'PATCH', "{$base}/{$a['id']}", ['revision' => $a['revision'], 'variants' => [['id' => $a['variants'][0]['id'], 'price_amount' => 99000]]])->assertOk();
        $this->assertNotNull($this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $a['id'])->dirty_at);
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();
        $run = $this->syncRuns($tenant)->last();
        $this->assertSame(['delta', 'product_change', 1], [$run->kind, $run->trigger, $run->items_sent]);
        $this->assertSame(0, $this->catalogItems($tenant, $integration->id)->whereNotNull('dirty_at')->count());
        // No dirty items → no delta run is queued.
        $count = $this->syncRuns($tenant)->count();
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();
        $this->assertSame($count, $this->syncRuns($tenant)->count());

        // A stock change marks dirty too.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments", ['reason' => 'correction', 'items' => [['variant_id' => $b['variants'][0]['id'], 'mode' => 'set', 'quantity' => 0]]])->assertOk();
        $this->assertNotNull($this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $b['id'])->dirty_at);
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();

        // A new product with "issue" in its name → disapproved with one issue → Needs attention, grouped on the overview.
        $c = $this->product($h, $store, 'Issue Bag', $img);
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();
        $item = $this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $c['id']);
        $this->assertSame(['synced', 'disapproved', 'image_too_small'], [$item->status, $item->review_status, $item->issues[0]['code']]);
        $row = $this->integrationRow($tenant, $store, 'meta_catalog');
        $this->assertSame(['needs_attention', ['items_with_issues']], [$row->status, $row->attentionReasons()]);
        $issues = $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/feed'))->json('data.issues');
        $this->assertSame([['code' => 'image_too_small', 'severity' => 'error', 'impact' => 'disapproved', 'products' => 1, 'fix' => 'product_editor']],
            array_map(fn ($i) => array_diff_key($i, ['message' => 1]), $issues));
        $this->assertCount(1, $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/items?has_issues=1'))->json('data'));

        // Unpublish → excluded + deleted remotely; delete → removed remotely and locally.
        $this->api($h, 'PATCH', "{$base}/{$c['id']}", ['revision' => $this->api($h, 'GET', "{$base}/{$c['id']}")->json('data.revision'), 'status' => 'draft'])->assertOk();
        $this->api($h, 'DELETE', "{$base}/{$b['id']}")->assertSuccessful();
        $this->artisan('feeds:sync-deltas', ['--sync' => true])->assertSuccessful();
        $this->assertSame([$a['variants'][0]['id']], FakeFeedDriver::$held[$integration->id]);
        $this->assertNull($this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $b['id']));
        $this->assertSame('excluded', $this->catalogItems($tenant, $integration->id)->firstWhere('product_id', $c['id'])->status);
        $this->assertSame(2, $this->syncRuns($tenant)->last()->items_deleted);
        $this->assertSame('connected', $this->integrationRow($tenant, $store, 'meta_catalog')->status);

        // Sync now = manual run, re-sends everything; 409 while a run is in progress.
        $r = $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/sync'))->assertStatus(202)->json('data');
        $this->assertSame(['manual', 'manual'], [$r['kind'], $r['trigger']]);
        $this->assertSame(['done', 1], [$this->syncRuns($tenant)->last()->status, $this->syncRuns($tenant)->last()->items_sent]);
        $this->platformTable('catalog_sync_runs')->insert(['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id,
            'store_integration_id' => $integration->id, 'kind' => 'full', 'trigger' => 'schedule', 'status' => 'running', 'items_sent' => 0, 'items_failed' => 0, 'items_deleted' => 0,
            'started_at' => now()]);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/sync'))->assertStatus(409)->assertJsonPath('error.code', 'feed_sync_in_progress');
        $this->assertContains('integration.sync_requested', array_column($this->audits($tenant), 'action'));
    }

    public function test_website_claim_steps_and_storefront_meta_token(): void
    {
        [$tenant, $store, $h] = $this->feedShop('claim');
        $this->api($h, 'POST', $this->intUrl($store, '/google_merchant/claim-website'))->assertStatus(409)->assertJsonPath('error.code', 'integration_setup_required');
        $d = $this->connectFeed($h, $store, 'google_merchant');
        $this->assertSame(['needs_attention', 'website_not_claimed'], [$d['status'], $d['attention'][0]['reason']]);
        $this->assertSame('100200300', $d['settings']['merchant_id']);

        $r = $this->api($h, 'POST', $this->intUrl($store, '/google_merchant/claim-website'))->assertOk()->json('data');
        $this->assertSame([true, 'connected', []], [$r['settings']['website_claimed'], $r['status'], $r['attention']]);
        Cache::flush();
        $token = $this->sf($store, 'GET', '/config')->assertOk()->json('data.tracking.site_verification.google');
        $this->assertStringStartsWith('fake-verification-', $token);
        $this->assertNull($this->sf($store, 'GET', '/config')->json('data.tracking.meta_pixel_id'));
        $this->assertContains('integration.website_claimed', array_column($this->audits($tenant), 'action'));

        // Failure: details.step; not live → 409.
        [$tenant2, $store2, $h2] = $this->feedShop('claimfail');
        $this->connectFeed($h2, $store2, 'google_merchant');
        $this->api($h2, 'POST', $this->intUrl($store2, '/google_merchant/claim-website'))->assertUnprocessable()
            ->assertJsonPath('error.code', 'website_claim_failed')->assertJsonPath('error.details.step', 'verify');
        $this->inTenant($tenant2, fn () => Store::query()->whereKey($store2->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->api($h2, 'POST', $this->intUrl($store2, '/google_merchant/claim-website'))->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
        $this->api($h2, 'POST', $this->intUrl($store2, '/google_merchant/sync'))->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
        $this->assertFalse($this->integrationRow($tenant2, $store2, 'google_merchant')->setting('website_claimed'));
    }

    public function test_disconnect_deletes_local_items_and_tokens_and_keeps_remote_products(): void
    {
        [$tenant, $store, $h, $img] = $this->feedShop('feeddisc');
        $this->product($h, $store, 'Linen Shirt', $img);
        $this->connectFeed($h, $store, 'google_merchant');
        $this->api($h, 'POST', $this->intUrl($store, '/google_merchant/claim-website'))->assertOk();
        $integration = $this->integrationRow($tenant, $store, 'google_merchant');
        $held = FakeFeedDriver::$held[$integration->id];
        $this->api($h, 'POST', $this->intUrl($store, '/google_merchant/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk()->assertJsonPath('data.status', 'disconnected')
            ->assertJsonPath('data.settings.website_claimed', false);
        $row = $this->integrationRow($tenant, $store, 'google_merchant');
        $this->assertSame([[], 0], [$row->secrets(), $this->catalogItems($tenant)->count()]);
        $this->assertSame($held, FakeFeedDriver::$held[$integration->id]); // "Storeplix deletes its access", products stay
        $audit = collect($this->audits($tenant))->firstWhere('action', 'integration.disconnected');
        $this->assertSame(1, $audit['meta']['items_deleted']);
        Cache::flush();
        $this->assertArrayNotHasKey('tracking', $this->sf($store, 'GET', '/config')->json('data'));
        // A disconnected feed is not synced.
        $this->artisan('feeds:sync', ['--sync' => true])->assertSuccessful();
        $this->assertSame(0, $this->catalogItems($tenant)->count());
        $this->api($h, 'GET', $this->intUrl($store, '/google_merchant/accounts'))->assertStatus(409);
    }

    public function test_plan_downgrade_pauses_sync_and_tokens_refresh_or_expire(): void
    {
        [$tenant, $store, $h, $img] = $this->feedShop('tokens');
        $this->product($h, $store, 'Linen Shirt', $img);
        $this->connectFeed($h, $store, 'google_merchant');
        $this->connectFeed($h, $store, 'meta_catalog');

        // Google: an access token about to expire is refreshed before the run.
        $this->platformTable('store_integrations')->where('provider', 'google_merchant')->update(['token_expires_at' => now()->addMinute()]);
        $before = $this->integrationRow($tenant, $store, 'google_merchant')->secrets()['access_token'];
        $this->api($h, 'POST', $this->intUrl($store, '/google_merchant/sync'))->assertStatus(202);
        $google = $this->integrationRow($tenant, $store, 'google_merchant');
        $this->assertNotSame($before, $google->secrets()['access_token']);
        $this->assertTrue($google->token_expires_at->isAfter(now()->addDays(30)));

        // Meta: < 10 days left → re-exchanged nightly; past expiry → token_expired (error, email once).
        $this->platformTable('store_integrations')->where('provider', 'meta_catalog')->update(['token_expires_at' => now()->addDays(5)]);
        $this->artisan('integrations:health')->assertSuccessful();
        $this->assertTrue($this->integrationRow($tenant, $store, 'meta_catalog')->token_expires_at->isAfter(now()->addDays(30)));
        $this->platformTable('store_integrations')->where('provider', 'meta_catalog')->update(['token_expires_at' => now()->subDay()]);
        $this->artisan('integrations:health')->assertSuccessful();
        $meta = $this->integrationRow($tenant, $store, 'meta_catalog');
        $this->assertSame(['error', ['token_expired']], [$meta->status, $meta->attentionReasons()]);
        Mail::assertQueued(IntegrationAlertMail::class, fn ($m) => $m->reason === 'token_expired');
        // Reconnect by OAuth clears it.
        $this->oauth($h, $store, 'meta_catalog');
        $this->assertSame('connected', $this->integrationRow($tenant, $store, 'meta_catalog')->status);

        // Downgrade to Free: scheduled runs fail plan_required + attention; reads stay; writes 402.
        $this->planFor($tenant, 'free');
        $this->artisan('feeds:sync', ['--sync' => true])->assertSuccessful();
        $this->assertSame(['failed', 'plan_required'], [$this->syncRuns($tenant)->last()->status, $this->syncRuns($tenant)->last()->error_code]);
        $this->assertContains('plan_required', $this->integrationRow($tenant, $store, 'meta_catalog')->attentionReasons());
        $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/items'))->assertOk();
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/sync'))->assertStatus(402);
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['account_id' => '100200300'])->assertStatus(402);
        $this->assertSame(StoreIntegration::NEEDS_ATTENTION, $this->integrationRow($tenant, $store, 'meta_catalog')->status);
        $this->assertInstanceOf(CatalogItem::class, $this->catalogItems($tenant)->first());
    }

    public function test_create_catalog_and_sync_now_limit(): void
    {
        $this->app->forgetInstance(ThrottleRequests::class);
        [$tenant, $store, $h] = $this->feedShop('create');
        $this->oauth($h, $store);
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['create_catalog' => true])->assertJsonValidationErrors(['parent_id'], 'error.details');
        $d = $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog/account'), ['create_catalog' => true, 'parent_id' => '900800700'])->assertOk()->json('data');
        $this->assertSame(['100200399', 'Storeplix · '.$store->name], [$d['settings']['catalog_id'], $d['settings']['catalog_name']]);
        $this->oauth($h, $store, 'google_merchant');
        $this->api($h, 'PUT', $this->intUrl($store, '/google_merchant/account'), ['create_catalog' => true, 'parent_id' => '1'])->assertJsonValidationErrors(['create_catalog'], 'error.details');

        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/sync'))->assertStatus(202);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/sync'))->assertStatus(429);
        $this->assertContains('integration.account_chosen', array_column($this->audits($tenant), 'action'));
    }
}
