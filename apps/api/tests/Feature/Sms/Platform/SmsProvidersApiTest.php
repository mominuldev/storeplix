<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Sms\Mail\PlatformSmsMail;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §4.6, §9.1: provider lifecycle — drivers, create (validation, coming soon, name taken, https / SSRF),
 * get / patch (revision, settings only on drafts), test, activate (typed name, test required, first activation, keep /
 * don't keep the old primary), rotate (fail keeps the old key, success swaps, S223), remove (never the primary), balance
 * + low-balance alert once per crossing, alerts, overview sources, permissions, credential secrecy (S220).
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class SmsProvidersApiTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
        Mail::fake();
    }

    public function test_driver_catalogue_marks_coming_soon_and_hides_dlr(): void
    {
        $data = $this->admin('GET', 'drivers')->assertOk()->json('data');
        $this->assertSame(['revesms', 'ssl_wireless', 'alpha_sms', 'bulksmsbd', 'http'], array_column($data, 'code'));
        $this->assertSame('available', $data[0]['status']);
        $this->assertTrue($data[0]['recommended']);
        $this->assertSame(['api_key', 'secret_key'], array_column($data[0]['credential_fields'], 'key'));
        $this->assertSame('coming_soon', $data[1]['status']);
        foreach ($data as $d) {
            $this->assertFalse($d['features']['dlr']);
        }
    }

    public function test_create_validates_and_never_returns_credentials(): void
    {
        $this->reveOk();
        $this->admin('POST', 'providers', $this->reveInput(['driver' => 'ssl_wireless']))->assertStatus(422)->assertJsonPath('error.code', 'sms_provider_driver_unavailable');
        $this->admin('POST', 'providers', $this->reveInput(['driver' => 'nope']))->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->admin('POST', 'providers', ['credentials' => ['api_key' => 'only-one']] + $this->reveInput())->assertStatus(422)->assertJsonValidationErrors(['credentials.secret_key'], 'error.details');
        foreach (['http://api.reve.example', 'https://169.254.169.254', 'https://10.0.0.5', 'https://127.0.0.1', 'https://localhost', 'https://u:p@api.reve.example', 'https://intranet'] as $bad) {
            $this->admin('POST', 'providers', $this->reveInput(['settings' => ['base_url' => $bad]]))->assertStatus(422)
                ->assertJsonValidationErrors(['settings.base_url'], 'error.details');
        }
        $this->admin('POST', 'providers', $this->reveInput(['default_sender_id' => 'ab']))->assertStatus(422);
        $this->admin('POST', 'providers', ['message_groups' => []] + $this->reveInput())->assertStatus(422);
        $this->admin('POST', 'providers', $this->reveInput(['message_groups' => ['nope']]))->assertStatus(422);

        $response = $this->admin('POST', 'providers', $this->reveInput())->assertCreated()
            ->assertJsonPath('data.role', 'draft')->assertJsonPath('data.test_required', true)
            ->assertJsonPath('data.credentials_hint.api_key', '••••'.substr(self::API_KEY, -4))
            ->assertJsonPath('data.settings.base_url', self::REVE_URL)->assertJsonPath('data.settings.account_id', 'ACC-77')
            ->assertJsonPath('data.price_masking_paisa', 45)->assertJsonPath('data.balance.status', 'unknown')
            ->assertJsonPath('data.low_threshold_paisa', null);
        $this->assertStringNotContainsString(self::API_KEY, $response->getContent());
        $this->assertStringNotContainsString(self::SECRET_KEY, $response->getContent());
        $this->assertSame(['id', 'driver', 'name', 'role', 'credentials_hint', 'settings', 'default_sender_id', 'promotional_sender_id',
            'promotional_sender_status', 'message_groups', 'rate_limit_per_minute', 'failover_after_failures', 'failover_timeout_seconds',
            'price_masking_paisa', 'price_non_masking_paisa', 'balance', 'health', 'accepted_rate_24h', 'last_sent_at', 'last_test',
            'test_required', 'credentials_rotated_at', 'credentials_rotated_by', 'activated_at', 'created_at', 'revision'], array_keys($response->json('data')));

        // Encrypted at rest; hidden on the model.
        $raw = $this->platformTable('sms_providers')->where('id', $response->json('data.id'))->first();
        $this->assertStringNotContainsString(self::API_KEY, (string) $raw->credentials_encrypted);
        $this->assertArrayNotHasKey('credentials_encrypted', $this->provider($response->json('data.id'))->toArray());

        // Name unique (case-insensitive) among non-removed providers.
        $this->admin('POST', 'providers', $this->reveInput(['name' => 'reve main']))->assertStatus(409)->assertJsonPath('error.code', 'sms_provider_name_taken');

        // Audit: field keys and hints only.
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.created')->sole();
        $this->assertSame('platform_user', $audit->actor_type);
        $this->assertNull($audit->tenant_id);
        $this->assertStringNotContainsString(self::API_KEY, json_encode($audit->meta));
        $this->assertSame(['api_key', 'secret_key'], $audit->meta['credential_fields']);
    }

    public function test_get_and_patch_with_revision_and_draft_only_connection_fields(): void
    {
        $this->reveOk();
        $id = $this->createProvider($this->reveInput());
        $this->admin('GET', "providers/{$id}")->assertOk()->assertJsonPath('data.id', $id);
        $this->admin('GET', 'providers/'.strtolower((string) Str::ulid()))->assertNotFound();

        $this->admin('PATCH', "providers/{$id}", ['revision' => 9, 'rate_limit_per_minute' => 100])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->admin('PATCH', "providers/{$id}", ['revision' => 1, 'rate_limit_per_minute' => 0])->assertStatus(422);
        $this->admin('PATCH', "providers/{$id}", ['revision' => 1, 'failover_timeout_seconds' => 31])->assertStatus(422);
        $this->admin('PATCH', "providers/{$id}", ['revision' => 1, 'rate_limit_per_minute' => 120, 'name' => 'REVE Two', 'low_threshold_paisa' => 50000,
            'settings' => ['account_id' => 'ACC-88']])->assertOk()
            ->assertJsonPath('data.rate_limit_per_minute', 120)->assertJsonPath('data.name', 'REVE Two')->assertJsonPath('data.settings.account_id', 'ACC-88')
            ->assertJsonPath('data.revision', 2)->assertJsonPath('data.balance.low_threshold_paisa', 50000);
        $this->assertSame(['rate_limit_per_minute', 'low_threshold_paisa', 'name', 'settings'],
            $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.updated')->sole()->meta['changed']);

        // Active providers: no rename, no connection change (rotate), primary keeps the required groups.
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711000001'])->assertOk();
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'REVE Two'])->assertOk();
        $rev = $this->provider($id)->revision;
        $this->admin('PATCH', "providers/{$id}", ['revision' => $rev, 'name' => 'Other'])->assertStatus(422);
        $this->admin('PATCH', "providers/{$id}", ['revision' => $rev, 'settings' => ['base_url' => 'https://other.example']])->assertStatus(422);
        $this->admin('PATCH', "providers/{$id}", ['revision' => $rev, 'message_groups' => ['shop']])->assertStatus(422);
        $this->admin('PATCH', "providers/{$id}", ['revision' => $rev, 'promotional_sender_status' => 'pending'])->assertOk()
            ->assertJsonPath('data.promotional_sender_status', 'pending');
    }

    public function test_test_send_records_the_result_and_balance(): void
    {
        $this->reveOk();
        $id = $this->createProvider($this->reveInput());
        $this->admin('POST', "providers/{$id}/test", ['phone' => '123'])->assertStatus(422);
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711-552211'])->assertOk()
            ->assertJsonPath('data.status', 'passed')->assertJsonPath('data.provider_message_id', '9001')->assertJsonPath('data.parts', 1)
            ->assertJsonPath('data.balance_paisa', 250050)->assertJsonPath('data.to_masked', '01711-•••211')->assertJsonPath('data.error_code', null);
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/sendtext') && $r['callerID'] === 'Storeplix' && $r['toUser'] === '8801711552211'
            && $r['messageContent'] === 'Store Plix SMS test from REVE Main. No action needed.');
        $p = $this->provider($id);
        $this->assertSame('passed', $p->last_test_status);
        $this->assertFalse($p->testRequired());
        $this->assertSame(250050, $p->balance_amount);
        $row = $this->platformQuery(SmsMessage::class)->where('purpose', 'platform_test')->sole();
        $this->assertNull($row->tenant_id);
        $this->assertSame($id, $row->provider_id);
        $this->assertSame('sent', $row->status);
        $this->assertSame('01711-•••211', $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.tested')->sole()->meta['to_masked']);

        // A failing test is a 200 with status failed; the provider's text is redacted.
        $this->httpFake(['*' => Http::response(['Status' => '109', 'Text' => 'Invalid key '.self::API_KEY])]);
        $failed = $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk()
            ->assertJsonPath('data.status', 'failed')->assertJsonPath('data.error_code', 'provider_auth');
        $this->assertStringNotContainsString(self::API_KEY, $failed->getContent());
        $this->assertTrue($this->provider($id)->testRequired());
    }

    public function test_activation_needs_the_typed_name_and_a_fresh_passing_test(): void
    {
        $this->reveOk();
        $this->useRouter();
        $this->admin('GET', 'providers')->assertOk()->assertJsonPath('data.source', 'environment')
            ->assertJsonPath('data.environment.driver', 'revesms')->assertJsonPath('data.environment.caller_id', 'StorePlix')
            ->assertJsonPath('data.environment.credentials_hint.api_key', '••••0001');
        $id = $this->createProvider($this->reveInput());
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'Wrong'])->assertStatus(422)->assertJsonPath('error.code', 'confirmation_mismatch');
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'reve main'])->assertStatus(409)->assertJsonPath('error.code', 'sms_provider_test_required');
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'nope'])->assertStatus(422);
        $this->assertSame('draft', $this->provider($id)->role);

        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk();
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => '  reve MAIN '])->assertOk()
            ->assertJsonPath('data.source', 'database')->assertJsonPath('data.primary.id', $id)->assertJsonPath('data.environment', null);
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.activated')->sole();
        $this->assertSame(['role' => 'primary', 'previous_primary_id' => null, 'previous_failover_id' => null, 'first' => true, 'kept_previous_as_failover' => false],
            array_diff_key($audit->meta, ['platform_role' => 1]));
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'REVE Main'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        // A failover needs the passing test only (no typed name).
        $http = $this->createProvider($this->httpInput());
        $this->httpFake(['alpha.example/*' => Http::response(['response_code' => 202, 'data' => ['request_id' => 'h-1']])]);
        $this->admin('POST', "providers/{$http}/activate", ['role' => 'failover'])->assertStatus(409)->assertJsonPath('error.code', 'sms_provider_test_required');
        $this->admin('POST', "providers/{$http}/test", ['phone' => '01711552211'])->assertOk()->assertJsonPath('data.status', 'passed')
            ->assertJsonPath('data.provider_message_id', 'h-1')->assertJsonPath('data.balance_paisa', null);
        $this->admin('POST', "providers/{$http}/activate", ['role' => 'failover'])->assertOk()->assertJsonPath('data.failover.id', $http);

        // Replacing the primary: keep the old one as the failover (the old failover becomes inactive) …
        $third = $this->createProvider($this->reveInput(['name' => 'REVE Backup']));
        $this->reveOk();
        $this->admin('POST', "providers/{$third}/test", ['phone' => '01711552211'])->assertOk();
        $this->admin('POST', "providers/{$third}/activate", ['role' => 'primary', 'confirm_name' => 'REVE Backup', 'keep_previous_as_failover' => true])->assertOk()
            ->assertJsonPath('data.primary.id', $third)->assertJsonPath('data.failover.id', $id)->assertJsonPath('data.others.0.id', $http)
            ->assertJsonPath('data.others.0.role', 'inactive');
        // … or not: the old primary becomes inactive, the failover stays.
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk();
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'REVE Main', 'keep_previous_as_failover' => false])->assertOk()
            ->assertJsonPath('data.primary.id', $id)->assertJsonPath('data.failover', null);
        $this->assertSame('inactive', $this->provider($third)->role);
        $this->assertSame(1, $this->platformTable('sms_providers')->where('role', 'primary')->count());
    }

    public function test_settings_change_on_a_draft_requires_a_new_test(): void
    {
        $this->reveOk();
        $id = $this->createProvider($this->reveInput());
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk();
        $this->travel(1)->seconds();
        $this->admin('PATCH', "providers/{$id}", ['revision' => 1, 'settings' => ['base_url' => 'https://api2.reve.example']])->assertOk()
            ->assertJsonPath('data.test_required', true);
        $this->admin('POST', "providers/{$id}/activate", ['role' => 'primary', 'confirm_name' => 'REVE Main'])->assertStatus(409);
    }

    public function test_rotation_swaps_only_after_a_passing_test(): void
    {
        $this->useRouter();
        $this->reveOk();
        $id = $this->activeProvider($this->reveInput());
        $before = $this->provider($id);
        $logged = [];
        Log::listen(function ($e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });

        // Failing new key: 422, nothing stored, the old key keeps sending.
        $this->httpFake(['*' => Http::response(['Status' => '109', 'Text' => 'Invalid credentials NEW-KEY-0000-FAIL'])]);
        $this->admin('POST', "providers/{$id}/rotate", ['credentials' => ['api_key' => 'NEW-KEY-0000-FAIL', 'secret_key' => 'NEW-SECRET-FAIL-1'], 'phone' => '01711552211'])
            ->assertStatus(422)->assertJsonPath('error.code', 'sms_provider_test_failed')->assertJsonPath('error.details.error_code', 'provider_auth');
        $after = $this->provider($id);
        $this->assertSame($before->credentials_encrypted, $after->credentials_encrypted);
        $this->assertSame($before->revision, $after->revision);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.rotation_failed')->count());

        // Passing new key: swapped atomically, audited, and later sends use it.
        $this->reveOk();
        $this->admin('POST', "providers/{$id}/rotate", ['credentials' => ['api_key' => 'NEW-KEY-1111-GOOD', 'secret_key' => 'NEW-SECRET-GOOD-2'],
            'settings' => ['account_id' => 'ACC-99'], 'phone' => '01711552211'])->assertOk()
            ->assertJsonPath('data.credentials_hint.api_key', '••••GOOD')->assertJsonPath('data.settings.account_id', 'ACC-99')
            ->assertJsonPath('data.test_required', false)->assertJsonPath('data.credentials_rotated_by.id', $this->super()->id);
        app(SmsGateway::class)->send('8801711552211', 'after rotation');
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/sendtext') && $r['messageContent'] === 'after rotation' && $r['apikey'] === 'NEW-KEY-1111-GOOD');
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.credentials_rotated')->sole();
        $this->assertSame(['api_key' => '••••GOOD', 'secret_key' => '••••OD-2'], $audit->meta['credentials_hint']);

        // S220 log scan: no credential in any log line.
        foreach ($logged as $line) {
            foreach (['NEW-KEY-0000-FAIL', 'NEW-SECRET-FAIL-1', 'NEW-KEY-1111-GOOD', 'NEW-SECRET-GOOD-2', self::API_KEY, self::SECRET_KEY] as $secret) {
                $this->assertStringNotContainsString($secret, $line);
            }
        }
        foreach ($this->platformQuery(AuditLog::class)->get() as $row) {
            $this->assertStringNotContainsString('NEW-KEY-1111-GOOD', (string) json_encode($row->meta));
        }
    }

    public function test_remove_never_the_primary_and_needs_the_name(): void
    {
        $this->reveOk();
        $primary = $this->activeProvider($this->reveInput());
        $this->admin('POST', "providers/{$primary}/remove", ['confirm_name' => 'REVE Main'])->assertStatus(409)->assertJsonPath('error.code', 'sms_provider_is_primary');
        $draft = $this->createProvider($this->reveInput(['name' => 'Spare']));
        $this->admin('POST', "providers/{$draft}/remove", ['confirm_name' => 'nope'])->assertStatus(422)->assertJsonPath('error.code', 'confirmation_mismatch');
        $this->admin('POST', "providers/{$draft}/remove", ['confirm_name' => 'spare'])->assertOk()->assertJsonPath('data.others', []);
        $row = $this->platformTable('sms_providers')->where('id', $draft)->first();
        $this->assertSame('removed', $row->role);
        $this->assertNull($row->credentials_encrypted);
        $this->admin('GET', "providers/{$draft}")->assertNotFound();
        // The name is free again.
        $this->createProvider($this->reveInput(['name' => 'Spare']));
    }

    public function test_balance_refresh_and_low_balance_alert_once_per_crossing(): void
    {
        $this->reveOk(balance: '500.00'); // below the ৳1,000 default threshold
        $id = $this->activeProvider($this->reveInput());
        Mail::assertQueued(PlatformSmsMail::class, 1); // the test read the balance: one alert
        $this->assertNotNull($this->provider($id)->low_balance_alerted_at);
        $this->admin('GET', 'alerts')->assertOk()->assertJsonPath('data.0.code', 'low_balance')->assertJsonPath('data.0.provider_id', $id);

        $this->artisan('sms:fetch-balances')->assertExitCode(0);
        $this->admin('POST', "providers/{$id}/refresh-balance")->assertOk()->assertJsonPath('data.balance.status', 'low')
            ->assertJsonPath('data.balance.amount_paisa', 50000)->assertJsonPath('data.balance.approx_parts', 1111);
        Mail::assertQueued(PlatformSmsMail::class, 1); // still one
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'sms_provider.low_balance')->count());

        // Back above → re-armed; below again → a second alert.
        $this->reveOk(balance: '5000');
        $this->admin('POST', "providers/{$id}/refresh-balance")->assertOk()->assertJsonPath('data.balance.status', 'ok');
        $this->assertNull($this->provider($id)->low_balance_alerted_at);
        $this->reveOk(balance: '10');
        $this->artisan('sms:fetch-balances')->assertExitCode(0);
        Mail::assertQueued(PlatformSmsMail::class, 2);

        // Two failed reads → balance_unavailable (info).
        $this->httpFake(['*' => Http::response('nope', 502)]);
        $this->artisan('sms:fetch-balances');
        $this->artisan('sms:fetch-balances');
        $codes = array_column($this->admin('GET', 'alerts')->json('data'), 'code');
        $this->assertContains('balance_unavailable', $codes);

        // Unsupported (HTTP driver).
        $this->httpFake(['alpha.example/*' => Http::response(['response_code' => 202])]);
        $http = $this->createProvider($this->httpInput());
        $this->admin('POST', "providers/{$http}/refresh-balance")->assertOk()->assertJsonPath('data.balance.status', 'unsupported');
    }

    public function test_refresh_balance_limiter(): void
    {
        $this->reveOk();
        $id = $this->createProvider($this->reveInput());
        for ($i = 0; $i < 6; $i++) {
            $this->admin('POST', "providers/{$id}/refresh-balance")->assertOk();
        }
        $this->admin('POST', "providers/{$id}/refresh-balance")->assertStatus(429);
    }

    public function test_admin_test_limiter_is_ten_per_hour(): void
    {
        config(['sms.platform.test_per_hour' => 10]);
        $this->reveOk();
        $id = $this->createProvider($this->reveInput());
        for ($i = 0; $i < 10; $i++) {
            $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk();
        }
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertStatus(429);
    }

    public function test_alerts_and_overview_per_source(): void
    {
        $this->useRouter(env: false);
        $this->admin('GET', 'alerts')->assertOk()->assertJsonPath('data.0.code', 'no_provider')->assertJsonPath('data.0.severity', 'danger');
        $this->admin('GET', 'providers')->assertOk()->assertJsonPath('data.source', 'none')
            ->assertJsonPath('data.waiting.0.group', 'shop')->assertJsonCount(5, 'data.waiting');

        $this->reveOk();
        $id = $this->activeProvider($this->reveInput(['promotional_sender_status' => 'pending']));
        $codes = array_column($this->admin('GET', 'alerts')->json('data'), 'code');
        $this->assertNotContains('no_provider', $codes);
        $this->assertContains('promotional_paused', $codes);
        $this->admin('GET', 'providers')->assertJsonPath('data.source', 'database')->assertJsonPath('data.primary.health', 'healthy')
            ->assertJsonPath('data.failover_active', false);
        app(SmsGateway::class)->send('8801711552211', 'hello');
        $this->admin('GET', 'providers')->assertJsonPath('data.primary.health', 'healthy')->assertJsonPath('data.primary.accepted_rate_24h', 100);
        $this->assertSame($id, $this->admin('GET', 'providers')->json('data.primary.id'));
    }

    public function test_billing_support_and_read_only_staff_are_refused(): void
    {
        foreach ([PlatformRole::Billing, PlatformRole::Support, PlatformRole::ReadOnly] as $role) {
            $staff = $this->staffUser($role);
            $this->admin('GET', 'providers', [], $staff)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            $this->admin('POST', 'providers', $this->reveInput(), $staff)->assertForbidden();
            $this->admin('GET', 'messages', [], $staff)->assertForbidden();
            $this->admin('POST', 'broadcasts/estimate', [], $staff)->assertForbidden();
        }
        // A merchant session (even of a super admin) is refused on the admin surface.
        [$merchant] = $this->merchant();
        $this->flushHeaders()->withHeaders($this->adminHeaders($merchant))->getJson('/api/v1/admin/sms/providers')->assertForbidden();
        $this->asAdminSurface(SessionSurface::MERCHANT)->flushHeaders()
            ->withHeaders($this->adminHeaders($this->super()))->getJson('/api/v1/admin/sms/providers')->assertForbidden();
        $this->assertSame(0, $this->platformTable('sms_providers')->count());
    }

    public function test_dns_rebinding_to_a_private_address_is_refused_at_send(): void
    {
        $this->useRouter(env: false);
        $this->httpFake(['*' => Http::response(['Status' => '0', 'Message_ID' => 1])]);
        $id = $this->createProvider($this->reveInput(['settings' => ['base_url' => 'https://rebind.example']]));
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk()
            ->assertJsonPath('data.status', 'failed')->assertJsonPath('data.error_code', 'provider_unavailable');
        Http::assertNothingSent();
    }
}
