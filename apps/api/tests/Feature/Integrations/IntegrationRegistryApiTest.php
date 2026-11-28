<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Feeds\Models\CatalogSyncRun;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Mail\IntegrationAlertMail;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tracking\Models\OrderTrackingContext;
use App\Domain\Tracking\Models\TrackingDailyStat;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-9D §4 registry (part A): list / get / connect (PUT) / settings (PATCH) / disconnect / verify; ID + pasted
 * code validation (P89D-6, S331), write-only credentials with hints (P89D-5/7, S332), revision lock, plan gates (P89D-40),
 * permissions + impersonation (P89D-41/42, S341), tenant and store isolation (S330), audit (P89D-23).
 */
#[Group('integrations')]
class IntegrationRegistryApiTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
    }

    public function test_list_shows_every_provider_in_order_with_status_summary_and_plan(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('list');
        $this->planFor($tenant, 'free');
        $list = $this->api($h, 'GET', $this->intUrl($store))->assertOk()->assertHeader('Cache-Control', 'no-store, private')->json('data');
        $this->assertSame(['meta_pixel', 'ga4', 'tiktok_pixel', 'gtm_server', 'meta_catalog', 'google_merchant', 'ai_writer', 'ai_photos'], array_column($list, 'provider'));
        $this->assertSame(['not_connected'], array_values(array_unique(array_column($list, 'status'))));
        $this->assertSame(['tracking', 'tracking', 'tracking', 'tracking', 'feed', 'feed', 'ai', 'ai'], array_column($list, 'kind'));
        // Free plan (P89D-40): feeds need product_feeds, GTM server_side_tagging; pixels and AI are on every plan.
        $this->assertSame([null, null, null, 'server_side_tagging', 'product_feeds', 'product_feeds', null, null], array_column($list, 'plan_required'));

        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $row = collect($this->api($h, 'GET', $this->intUrl($store))->json('data'))->firstWhere('provider', 'meta_pixel');
        $this->assertSame(['connected', 'Pixel 1234…3456 · CAPI on', []], [$row['status'], $row['summary'], $row['attention']]);
    }

    public function test_get_unconnected_returns_defaults_and_capabilities(): void
    {
        [, , $store, $h] = $this->liveShop('get');
        $d = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel'))->assertOk()->json('data');
        $this->assertSame(['not_connected', null, 0], [$d['status'], $d['settings'], $d['revision']]);
        $this->assertSame(['pixel_id' => null, 'purchase_trigger' => 'order_confirmed', 'include_delivery_charge' => false, 'wait_for_consent' => false,
            'send_customer_data' => true, 'mirror_browser_events' => true, 'test_event_code' => null], $d['defaults']);
        $this->assertSame([], (array) $d['credentials_hint']);
        $this->assertSame(['manage' => true, 'send_test' => false, 'view_events' => true, 'sync_now' => false], $d['can']);
        $this->assertTrue($this->api($h, 'GET', $this->intUrl($store, '/ga4'))->json('data.defaults.send_refunds'));
        $this->assertSame(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'], $this->api($h, 'GET', $this->intUrl($store, '/gtm_server'))->json('data.defaults.events'));
        $this->assertSame(['include' => 'all', 'category_ids' => [], 'hide_sold_out' => false, 'use_sale_price' => true, 'merchant_id' => null, 'account_name' => null,
            'website_claimed' => false, 'feed_language' => 'bn', 'condition' => 'new'], $this->api($h, 'GET', $this->intUrl($store, '/google_merchant'))->json('data.defaults'));
        $this->assertSame('bn', $this->api($h, 'GET', $this->intUrl($store, '/ai_writer'))->json('data.defaults.default_language'));
        $this->api($h, 'GET', $this->intUrl($store, '/nagad'))->assertNotFound();
        $this->api($h, 'GET', $this->intUrl($store, '/bogus'))->assertNotFound();
    }

    public function test_connect_validates_ids_normalises_and_stores_write_only_credentials_with_hints(): void
    {
        Bus::fake([RevalidateStorefront::class]);
        [, $tenant, $store, $h] = $this->liveShop('connect');
        $r = $this->connect($h, $store, 'tiktok_pixel', ['pixel_id' => ' c0abcdefghij12345678 ', 'test_event_code' => 'TEST1234'])->assertOk();
        $this->assertSame(['connected', 'C0ABCDEFGHIJ12345678', 1], [$r->json('data.status'), $r->json('data.settings.pixel_id'), $r->json('data.revision')]);
        $this->assertSame(['access_token' => '••••5555'], $r->json('data.credentials_hint'));
        $this->assertStringNotContainsString(self::TIKTOK_TOKEN, $r->getContent());
        $this->assertNotNull($r->json('data.last_verified_at'));
        Bus::assertDispatched(RevalidateStorefront::class);

        $row = $this->integrationRow($tenant, $store, 'tiktok_pixel');
        $this->assertSame(self::TIKTOK_TOKEN, $row->secrets()['access_token']);
        $raw = (string) $this->platformTable('store_integrations')->where('id', $row->id)->value('credentials');
        $this->assertStringNotContainsString(self::TIKTOK_TOKEN, $raw); // encrypted at rest (S332)
        $this->assertArrayNotHasKey('credentials', $row->toArray());

        // GET never shows a secret either.
        $this->assertStringNotContainsString(self::TIKTOK_TOKEN, $this->api($h, 'GET', $this->intUrl($store, '/tiktok_pixel'))->getContent());

        // Credential merge: omitted = keep; a new value replaces and is audited by name + hint only.
        $this->connect($h, $store, 'tiktok_pixel', ['include_delivery_charge' => true], [], 1)->assertOk()->assertJsonPath('data.credentials_hint.access_token', '••••5555');
        $this->assertSame(self::TIKTOK_TOKEN, $this->integrationRow($tenant, $store, 'tiktok_pixel')->secrets()['access_token']);
        $this->connect($h, $store, 'tiktok_pixel', [], ['access_token' => 'replacementTokenValue7777'], 2)->assertOk()->assertJsonPath('data.credentials_hint.access_token', '••••7777');

        $audits = $this->audits($tenant);
        $this->assertSame(['integration.connected', 'integration.updated', 'integration.credentials_replaced'], array_column($audits, 'action'));
        $this->assertSame(['access_token'], $audits[2]['meta']['fields']);
        $this->assertSame(['access_token' => '••••7777'], $audits[2]['meta']['credentials_hint']);
        $this->assertSame(['include_delivery_charge'], $audits[1]['meta']['changed']);
        foreach ($audits as $a) {
            $json = (string) json_encode($a['meta']);
            $this->assertStringNotContainsString(self::TIKTOK_TOKEN, $json);
            $this->assertStringNotContainsString('replacementTokenValue7777', $json);
        }
    }

    /** @return array<string, array{0: string, 1: array<string, mixed>, 2: string, 3: string}> */
    public static function invalidInputs(): array
    {
        return [
            'meta script snippet' => ['meta_pixel', ['pixel_id' => "<script>!function(f,b,e,v){fbq('init','123')}</script>"], 'integration_code_pasted', 'settings.pixel_id'],
            'fbq call' => ['meta_pixel', ['pixel_id' => "fbq('init', '1234567890')"], 'integration_code_pasted', 'settings.pixel_id'],
            'gtag call' => ['ga4', ['measurement_id' => "gtag('config', 'G-ABC123')"], 'integration_code_pasted', 'settings.measurement_id'],
            'tiktok ttq' => ['tiktok_pixel', ['pixel_id' => "ttq.load('C0ABCDEFGHIJ12345678')"], 'integration_code_pasted', 'settings.pixel_id'],
            'gtm.js web container' => ['gtm_server', ['tagging_server_url' => 'https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12'], 'integration_code_pasted', 'settings.tagging_server_url'],
            'function in test code' => ['meta_pixel', ['test_event_code' => 'function(){}'], 'integration_code_pasted', 'settings.test_event_code'],
            'noscript img' => ['meta_pixel', ['pixel_id' => '<noscript><img src="x"></noscript>'], 'integration_code_pasted', 'settings.pixel_id'],
            'meta id too short' => ['meta_pixel', ['pixel_id' => '12345'], 'integration_id_invalid', 'settings.pixel_id'],
            'meta id letters' => ['meta_pixel', ['pixel_id' => '12345abcde12'], 'integration_id_invalid', 'settings.pixel_id'],
            'ga4 wrong prefix' => ['ga4', ['measurement_id' => 'UA-12345-1'], 'integration_id_invalid', 'settings.measurement_id'],
            'tiktok 19 chars' => ['tiktok_pixel', ['pixel_id' => 'C0ABCDEFGHIJ1234567'], 'integration_id_invalid', 'settings.pixel_id'],
            'gtm bad container' => ['gtm_server', ['container_id' => 'GTM-'], 'integration_id_invalid', 'settings.container_id'],
            'gtm web host' => ['gtm_server', ['tagging_server_url' => 'https://www.googletagmanager.com/'], 'integration_id_invalid', 'settings.tagging_server_url'],
            'test code symbols' => ['meta_pixel', ['test_event_code' => 'TEST-12'], 'integration_id_invalid', 'settings.test_event_code'],
            'gtm http' => ['gtm_server', ['tagging_server_url' => 'http://sgtm.example.com'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm ip literal' => ['gtm_server', ['tagging_server_url' => 'https://10.0.0.5'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm localhost' => ['gtm_server', ['tagging_server_url' => 'https://localhost'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm internal suffix' => ['gtm_server', ['tagging_server_url' => 'https://sgtm.corp'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm port' => ['gtm_server', ['tagging_server_url' => 'https://sgtm.example.com:8443'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm userinfo' => ['gtm_server', ['tagging_server_url' => 'https://u:p@sgtm.example.com'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
            'gtm query' => ['gtm_server', ['tagging_server_url' => 'https://sgtm.example.com/?a=1'], 'integration_endpoint_blocked', 'settings.tagging_server_url'],
        ];
    }

    /** @param array<string, mixed> $settings */
    #[DataProvider('invalidInputs')]
    #[Group('security')]
    public function test_ids_only_pasted_code_and_bad_ids_are_refused(string $provider, array $settings, string $code, string $field): void
    {
        [, $tenant, $store, $h] = $this->liveShop('ids');
        $this->planFor($tenant, 'growth');
        $this->connect($h, $store, $provider, $settings)->assertUnprocessable()->assertJsonPath('error.code', $code)->assertJsonPath('error.details.field', $field);
        $this->assertNull($this->integrationRow($tenant, $store, $provider));
    }

    public function test_validation_unknown_keys_types_credentials_and_feeds_need_oauth(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('valid');
        $this->planFor($tenant, 'starter');
        $this->connect($h, $store, 'meta_pixel', ['script' => 'x'])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonValidationErrors(['settings.script'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', ['purchase_trigger' => 'order_paid'])->assertJsonValidationErrors(['settings.purchase_trigger'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', ['wait_for_consent' => 'yes'])->assertJsonValidationErrors(['settings.wait_for_consent'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', [], [])->assertJsonValidationErrors(['credentials.access_token'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => 'short'])->assertJsonValidationErrors(['credentials.access_token'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => 'has spaces inside the token'])->assertJsonValidationErrors(['credentials.access_token'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => self::META_TOKEN, 'app_secret' => 'x'])->assertJsonValidationErrors(['credentials.app_secret'], 'error.details');
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => '<script>alert(1)</script>xxxxxxxxxxxx'])->assertJsonPath('error.code', 'integration_code_pasted')
            ->assertJsonPath('error.details.field', 'credentials.access_token');
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_pixel'), [])->assertJsonValidationErrors(['settings'], 'error.details');
        // Feeds connect by OAuth only (§4.2).
        $this->api($h, 'PUT', $this->intUrl($store, '/meta_catalog'), ['settings' => ['include' => 'all']])->assertUnprocessable()->assertJsonPath('error.code', 'integration_setup_required');
        // A token the provider refuses (fake: contains "fail") → 422 credentials invalid, nothing saved.
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => 'thisTokenWillFAILcheck'])->assertUnprocessable()
            ->assertJsonPath('error.code', 'integration_credentials_invalid')->assertJsonPath('error.details.field', 'credentials.access_token');
        $this->assertNull($this->integrationRow($tenant, $store, 'meta_pixel'));
    }

    public function test_revision_lock_patch_and_reconnect(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('rev');
        $this->connect($h, $store, 'ga4')->assertOk();
        // A second PUT must name the revision.
        $this->connect($h, $store, 'ga4')->assertJsonValidationErrors(['revision'], 'error.details');
        $this->connect($h, $store, 'ga4', [], null, 7)->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');

        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => ['send_refunds' => false], 'revision' => 1])->assertOk()
            ->assertJsonPath('data.settings.send_refunds', false)->assertJsonPath('data.revision', 2)->assertJsonPath('data.settings.measurement_id', 'G-ABC123XYZ');
        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => ['send_refunds' => true], 'revision' => 1])->assertStatus(409);
        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => [], 'revision' => 2, 'credentials' => ['api_secret' => 'x']])->assertJsonValidationErrors(['credentials'], 'error.details');
        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => ['measurement_id' => 'bad'], 'revision' => 2])->assertJsonPath('error.code', 'integration_id_invalid');
        $this->api($h, 'PATCH', $this->intUrl($store, '/tiktok_pixel'), ['settings' => ['wait_for_consent' => true], 'revision' => 1])->assertUnprocessable()->assertJsonPath('error.code', 'integration_not_connected');

        // Disconnect needs the typed word; then the row is kept, credentials gone; reconnect starts fresh.
        $this->api($h, 'POST', $this->intUrl($store, '/ga4/disconnect'), ['confirm' => 'disconnect'])->assertUnprocessable()->assertJsonPath('error.code', 'confirmation_mismatch');
        $this->api($h, 'POST', $this->intUrl($store, '/ga4/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk()->assertJsonPath('data.status', 'disconnected')
            ->assertJsonPath('data.credentials_hint', []);
        $row = $this->integrationRow($tenant, $store, 'ga4');
        $this->assertSame([[], null], [$row->secrets(), $row->credentials]);
        $this->api($h, 'POST', $this->intUrl($store, '/ga4/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk(); // idempotent
        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => ['send_refunds' => true], 'revision' => 4])->assertJsonPath('error.code', 'integration_not_connected');
        $this->connect($h, $store, 'ga4', [], null, $row->revision)->assertOk()->assertJsonPath('data.status', 'connected')->assertJsonPath('data.settings.send_refunds', true);
        $this->assertSame(['integration.connected', 'integration.updated', 'integration.disconnected', 'integration.connected'], array_column($this->audits($tenant), 'action'));
    }

    public function test_verify_rows_per_provider_and_auth_failure_flags_token_invalid_and_emails_once(): void
    {
        [$owner, $tenant, $store, $h] = $this->liveShop('verify');
        [$admin] = $this->merchant(TenantUser::ROLE_ADMIN, $tenant);
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertUnprocessable()->assertJsonPath('error.code', 'integration_not_connected');
        $this->connect($h, $store, 'meta_pixel', ['test_event_code' => 'TEST1234'])->assertOk();
        $v = $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertOk()->json('data');
        $this->assertTrue($v['ok']);
        $this->assertSame(['id_format', 'token', 'found', 'server_events', 'consent', 'test_code'], array_column($v['rows'], 'key'));
        $this->assertSame('Storeplix test pixel', $v['found_name']);

        // The token stops working (fake: a stored token containing "fail") → verify fails, attention token_invalid → error,
        // owner + admins emailed once; a second verify does not mail again.
        $this->inTenant($tenant, function () use ($store) {
            $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', 'meta_pixel')->firstOrFail();
            $row->credentials = ['access_token' => 'nowItWillFAILforSure1'];
            $row->save();
        });
        $v = $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertOk()->json('data');
        $this->assertFalse($v['ok']);
        $this->assertSame('fail', collect($v['rows'])->firstWhere('key', 'token')['state']);
        $row = $this->integrationRow($tenant, $store, 'meta_pixel');
        $this->assertSame(['error', ['token_invalid']], [$row->status, $row->attentionReasons()]);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertOk();
        Mail::assertQueuedCount(2);
        Mail::assertQueued(IntegrationAlertMail::class, fn ($m) => $m->hasTo($owner->email));
        Mail::assertQueued(IntegrationAlertMail::class, fn ($m) => $m->hasTo($admin->email));
        Mail::assertNotQueued(IntegrationAlertMail::class, fn ($m) => $m->hasTo($staff->email));
        $this->assertSame('error', $this->api($h, 'GET', $this->intUrl($store))->json('data.0.status'));
        $this->assertSame('Pixel 1234…3456 · CAPI off', $this->api($h, 'GET', $this->intUrl($store))->json('data.0.summary'));

        // Replacing the token clears the flag.
        $this->connect($h, $store, 'meta_pixel', [], ['access_token' => 'aFreshWorkingToken12345'], $row->revision)->assertOk()->assertJsonPath('data.status', 'connected')
            ->assertJsonPath('data.attention', []);
    }

    public function test_plan_gates_feeds_and_gtm_writes_402_and_downgrade_pauses_with_attention(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('plan');
        $this->planFor($tenant, 'free');
        $this->connect($h, $store, 'gtm_server')->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/oauth/start'))->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->planFor($tenant, 'starter');
        $this->connect($h, $store, 'gtm_server')->assertStatus(402);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/oauth/start'))->assertOk();
        $this->planFor($tenant, 'growth');
        $this->connect($h, $store, 'gtm_server')->assertOk()->assertJsonPath('data.status', 'connected')
            ->assertJsonPath('data.summary', null)->assertJsonPath('data.plan_required', null);

        // Downgrade: reads stay, writes 402, the card says plan_required; the nightly health check records it.
        $this->planFor($tenant, 'starter');
        $d = $this->api($h, 'GET', $this->intUrl($store, '/gtm_server'))->assertOk()->json('data');
        $this->assertSame(['server_side_tagging', 'plan_required'], [$d['plan_required'], $d['attention'][0]['reason']]);
        $this->api($h, 'PATCH', $this->intUrl($store, '/gtm_server'), ['settings' => ['events' => ['purchase']], 'revision' => 1])->assertStatus(402);
        $this->artisan('integrations:health')->assertSuccessful();
        $this->assertSame(['needs_attention', ['plan_required']], [$this->integrationRow($tenant, $store, 'gtm_server')->status, $this->integrationRow($tenant, $store, 'gtm_server')->attentionReasons()]);
        $this->planFor($tenant, 'growth');
        $this->artisan('integrations:health')->assertSuccessful();
        $this->assertSame('connected', $this->integrationRow($tenant, $store, 'gtm_server')->status);
    }

    #[Group('security')]
    public function test_permission_matrix_owner_admin_staff_custom_role(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('perm');
        $this->planFor($tenant, 'growth');
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $marketer = $this->memberWithRole($tenant, $this->customRole($h, 'Marketer', ['marketing.manage']))[1];
        $this->connect($admin, $store, 'meta_pixel')->assertOk();

        // Staff (products.edit): the list shows AI rows only; nothing else.
        $this->assertSame(['ai_writer', 'ai_photos'], array_column($this->api($staff, 'GET', $this->intUrl($store))->assertOk()->json('data'), 'provider'));
        foreach ([['GET', '/meta_pixel'], ['PUT', '/ga4'], ['PATCH', '/meta_pixel'], ['POST', '/meta_pixel/disconnect'], ['POST', '/meta_pixel/verify'],
            ['POST', '/meta_pixel/test-event'], ['GET', '/meta_pixel/events'], ['GET', '/meta_pixel/stats'], ['POST', '/meta_catalog/oauth/start'],
            ['GET', '/meta_catalog/feed'], ['GET', '/meta_catalog/items'], ['POST', '/meta_catalog/sync']] as [$m, $p]) {
            $this->api($staff, $m, $this->intUrl($store, $p), ['settings' => [], 'confirm' => 'DISCONNECT'])->assertForbidden();
        }
        // marketing.manage reads but never writes; `can.manage` false.
        $this->assertCount(8, $this->api($marketer, 'GET', $this->intUrl($store))->assertOk()->json('data'));
        $this->api($marketer, 'GET', $this->intUrl($store, '/meta_pixel'))->assertOk()->assertJsonPath('data.can.manage', false)->assertJsonPath('data.can.view_events', true);
        $this->api($marketer, 'GET', $this->intUrl($store, '/meta_pixel/events'))->assertOk();
        $this->api($marketer, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertOk();
        $this->api($marketer, 'PATCH', $this->intUrl($store, '/meta_pixel'), ['settings' => [], 'revision' => 1])->assertForbidden();
        $this->api($marketer, 'POST', $this->intUrl($store, '/meta_pixel/test-event'))->assertForbidden();
        $this->api($marketer, 'POST', $this->intUrl($store, '/meta_pixel/disconnect'), ['confirm' => 'DISCONNECT'])->assertForbidden();
        // Admin (Manager) configures everything.
        $this->api($admin, 'GET', $this->intUrl($store, '/meta_pixel'))->assertOk()->assertJsonPath('data.can.manage', true)->assertJsonPath('data.can.send_test', true);
        $this->api($admin, 'POST', $this->intUrl($store, '/meta_pixel/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk();
    }

    #[Group('security')]
    public function test_cross_tenant_and_cross_store_access_is_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->liveShop('alpha');
        [, $tenantB, $storeB, $hB] = $this->liveShop('beta');
        $this->planFor($tenantB, 'growth');
        $this->stocked($hB, $storeB);
        $this->connect($hB, $storeB, 'meta_pixel')->assertOk();
        $this->connectFeed($hB, $storeB);
        $this->connect($hA, $storeA, 'meta_pixel')->assertOk();

        $requests = [];
        foreach ([['GET', ''], ['GET', '/meta_pixel'], ['PUT', '/meta_pixel'], ['PATCH', '/meta_pixel'], ['POST', '/meta_pixel/disconnect'], ['POST', '/meta_pixel/verify'],
            ['POST', '/meta_pixel/test-event'], ['POST', '/meta_pixel/test-mode'], ['GET', '/meta_pixel/events'], ['GET', '/meta_pixel/stats'],
            ['POST', '/meta_catalog/oauth/start'], ['GET', '/meta_catalog/accounts'], ['PUT', '/meta_catalog/account'], ['GET', '/meta_catalog/feed'],
            ['GET', '/meta_catalog/items'], ['GET', '/meta_catalog/sync-runs'], ['POST', '/meta_catalog/sync'], ['POST', '/google_merchant/claim-website']] as [$m, $p]) {
            $requests[] = [$m, $this->intUrl($storeB, $p), ['settings' => ['pixel_id' => self::META_PIXEL], 'revision' => 1, 'confirm' => 'DISCONNECT', 'account_id' => '100200300']];
        }
        // Tenant A's member with A's tenant header on B's store → 404 (store not in the tenant), and B's rows unchanged.
        foreach ($requests as [$m, $url, $body]) {
            $this->api($hA, $m, $url, $body)->assertNotFound();
        }
        // Tenant B's header with A's store → 404 as well.
        $this->api($hB, 'GET', $this->intUrl($storeA, '/meta_pixel'))->assertNotFound();
        $this->assertSame('connected', $this->integrationRow($tenantB, $storeB, 'meta_pixel')->status);
        $this->assertSame(1, $this->integrationRow($tenantB, $storeB, 'meta_pixel')->revision);

        foreach ([StoreIntegration::class, TrackingEvent::class, CatalogItem::class,
            CatalogSyncRun::class, TrackingDailyStat::class, OrderTrackingContext::class] as $model) {
            $this->assertStoreIsolation($model, $tenantA, $storeA, $storeB);
        }
        $this->assertGreaterThan(0, $this->catalogItems($tenantB)->count());
    }

    public function test_ai_tools_turn_on_and_off_as_integrations(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('ai');
        $this->api($h, 'PUT', $this->intUrl($store, '/ai_writer'), ['settings' => ['default_tone' => 'premium']])->assertOk()
            ->assertJsonPath('data.status', 'connected')->assertJsonPath('data.settings.default_tone', 'premium')->assertJsonPath('data.summary', null);
        $this->api($h, 'PUT', $this->intUrl($store, '/ai_photos'), ['settings' => ['default_background' => 'neon']])->assertJsonValidationErrors(['settings.default_background'], 'error.details');
        $this->api($h, 'POST', $this->intUrl($store, '/ai_writer/verify'))->assertOk()->assertJsonPath('data.ok', true);
        $this->api($h, 'POST', $this->intUrl($store, '/ai_writer/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk()->assertJsonPath('data.status', 'disconnected');
        $this->assertSame(['integration.turned_on', 'integration.turned_off'], array_column($this->audits($tenant), 'action'));
        // Tracking-only and feed-only routes 404 for the other kinds.
        $this->api($h, 'POST', $this->intUrl($store, '/ai_writer/test-event'))->assertNotFound();
        $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/feed'))->assertNotFound();
        $this->api($h, 'POST', $this->intUrl($store, '/ga4/test-mode'))->assertNotFound();
        $this->api($h, 'POST', $this->intUrl($store, '/meta_catalog/claim-website'))->assertNotFound();
    }

    #[Group('security')]
    public function test_impersonation_reads_but_every_write_is_403(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('imp');
        $this->connect($h, $store, 'meta_pixel', ['test_event_code' => 'TEST1234'])->assertOk();

        $this->useSpaBrowser();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: pixel check', 'ZD-99', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $started = $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')]);
        if ($started->status() === 419) {
            $this->markTestSkipped('SPA session cookie unavailable in this local environment (pre-existing 419).');
        }
        $started->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', $this->intUrl($store), [], $t)->assertOk();
        $this->browser('GET', $this->intUrl($store, '/meta_pixel'), [], $t)->assertOk()->assertJsonPath('data.can.manage', false);
        $this->browser('GET', $this->intUrl($store, '/meta_pixel/events'), [], $t)->assertOk();
        foreach ([['PUT', '/meta_pixel'], ['PATCH', '/meta_pixel'], ['POST', '/meta_pixel/disconnect'], ['POST', '/meta_pixel/verify'], ['POST', '/meta_pixel/test-event'],
            ['POST', '/meta_pixel/test-mode'], ['POST', '/meta_catalog/oauth/start'], ['PUT', '/meta_catalog/account'], ['POST', '/meta_catalog/sync']] as [$m, $p]) {
            $this->browser($m, $this->intUrl($store, $p), ['settings' => [], 'revision' => 1, 'confirm' => 'DISCONNECT'], $t)
                ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        }
        $this->assertSame('connected', $this->integrationRow($tenant, $store, 'meta_pixel')->status);
    }
}
