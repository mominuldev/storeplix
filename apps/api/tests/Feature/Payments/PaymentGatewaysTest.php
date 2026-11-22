<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Payments\PaymentManager;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-5B §4.1 / §13 "Gateways" (P5B-10/11/29), S26, S27, S38, S39. */
#[Group('payments')]
class PaymentGatewaysTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    private const BKASH = ['app_key' => 'appkey-sandbox-3f9a', 'app_secret' => 'super-secret-app-secret', 'username' => 'sandboxTokenizedUser02', 'password' => 'Sandbox-Pass-77'];

    private const SSL = ['store_id' => 'testbox1234', 'store_passwd' => 'qwerty-store-pass'];

    private const KEYS = ['provider', 'status', 'mode', 'credentials_hint', 'enabled', 'is_default', 'verified_at', 'last_checked_at', 'last_error_code', 'connected_by', 'connected_at', 'revision'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        config(['payments.fake' => true]);
        if (! Route::has('payments.return')) { // API-2's return handler; a stub keeps this suite independent of it
            Route::get('api/v1/payments/return/{provider}/{payment}', fn () => 'ok')->name('payments.return');
            app('router')->getRoutes()->refreshNameLookups();
        }
    }

    private function url(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/payment-gateways".$suffix;
    }

    private function connect(array $h, Store $store, string $provider = 'bkash', ?array $credentials = null, string $mode = 'sandbox')
    {
        return $this->api($h, 'PUT', $this->url($store, "/{$provider}"), ['mode' => $mode, 'credentials' => $credentials ?? ($provider === 'bkash' ? self::BKASH : self::SSL)]);
    }

    private function startTestPayment(array $h, Store $store, string $provider = 'bkash', ?string $key = null)
    {
        return $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()])
            ->postJson($this->url($store, "/{$provider}/test-payment"));
    }

    public function test_list_shows_both_providers_and_absent_ones_as_not_connected(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $data = $this->api($h, 'GET', $this->url($store))->assertOk()->json('data');
        $this->assertSame(['bkash', 'sslcommerz'], array_column($data, 'provider'));
        foreach ($data as $row) {
            $this->assertSame(self::KEYS, array_keys($row));
            $this->assertSame(['not_connected', null, false, 0], [$row['status'], $row['mode'], $row['enabled'], $row['revision']]);
        }
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($staff, 'GET', $this->url($store))->assertOk();
    }

    public function test_connect_bkash_checks_credentials_with_a_grant_and_never_returns_or_logs_secrets(): void
    {
        config(['payments.fake' => false]);
        Http::fake(['tokenized.sandbox.bka.sh/*' => Http::response($this->fixture('bkash/grant_token'))]);
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        [$user, $tenant, $store, $h] = $this->liveShop();

        $res = $this->connect($h, $store)->assertOk();
        $this->assertSame(self::KEYS, array_keys($res->json('data')));
        $res->assertJsonPath('data.status', 'connected')->assertJsonPath('data.mode', 'sandbox')
            ->assertJsonPath('data.credentials_hint', '••••3f9a')->assertJsonPath('data.enabled', false)
            ->assertJsonPath('data.revision', 1)->assertJsonPath('data.connected_by.id', $user->id)
            ->assertJsonPath('data.verified_at', null);
        $this->assertNotNull($res->json('data.connected_at'));
        foreach (self::BKASH as $secret) {
            $this->assertStringNotContainsString($secret, $res->getContent());
        }

        Http::assertSent(fn ($r) => $r->url() === 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout/auth/grant-token'
            && $r->hasHeader('username', self::BKASH['username']) && $r['app_key'] === self::BKASH['app_key']);

        // S26: the column is ciphertext, decrypts with the dedicated key only; the audit row holds no secret.
        $raw = (string) $this->platformTable('payment_gateway_accounts')->value('credentials');
        foreach (self::BKASH as $secret) {
            $this->assertStringNotContainsString($secret, $raw);
        }
        $account = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->firstOrFail());
        $this->assertSame(self::BKASH, $account->credentials);
        $this->assertSame(32, strlen($account->route_key));
        $this->assertArrayNotHasKey('credentials', $account->toArray());
        $audit = $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.connected')->firstOrFail());
        $this->assertSame(['kind' => 'payment_gateway', 'provider' => 'bkash', 'mode' => 'sandbox', 'replaced' => false], $audit->meta);
        foreach (self::BKASH as $secret) {
            $this->assertStringNotContainsString($secret, json_encode($audit->toArray()));
        }
        // Log lines carry provider, action, status and ids only: no secret, no id_token.
        $this->assertNotEmpty($logged);
        foreach ($logged as $line) {
            $this->assertStringNotContainsString('eyJ', $line);
            foreach (self::BKASH as $secret) {
                $this->assertStringNotContainsString($secret, $line);
            }
        }
    }

    public function test_connect_rejects_invalid_credentials_and_reports_timeouts(): void
    {
        config(['payments.fake' => false]);
        [, $tenant, $store, $h] = $this->liveShop();

        $next = 'bkash/grant_token_invalid';
        Http::fake(function () use (&$next) {
            return $next === 'timeout' ? throw new ConnectionException('timed out') : Http::response($this->fixture($next));
        });
        $this->connect($h, $store)->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');

        $next = 'sslcommerz/session_failed';
        $this->connect($h, $store, 'sslcommerz')->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');

        $next = 'timeout';
        $this->connect($h, $store, 'sslcommerz')->assertStatus(502)->assertJsonPath('error.code', 'provider_unavailable');

        $this->assertSame(0, $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->count()), 'nothing saved on failure');

        $next = 'sslcommerz/session';
        $this->connect($h, $store, 'sslcommerz')->assertOk()->assertJsonPath('data.credentials_hint', '••••1234');
        Http::assertSent(fn ($r) => str_ends_with($r->url(), '/gwprocess/v4/api.php') && $r['store_id'] === self::SSL['store_id'] && $r['total_amount'] === '10.00');
    }

    public function test_connect_validation_and_replacing_credentials(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->connect($h, $store, 'bkash', ['app_key' => 'x'] + self::BKASH + ['base_url' => 'https://evil.example'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed'); // S27: no host can be supplied
        $this->connect($h, $store, 'bkash', array_diff_key(self::BKASH, ['password' => 1]))->assertStatus(422);
        $this->connect($h, $store, 'bkash', ['app_key' => str_repeat('a', 65)] + self::BKASH)->assertStatus(422);
        $this->connect($h, $store, 'bkash', null, 'live')->assertStatus(422)->assertJsonValidationErrors('mode', 'error.details'); // no BKASH_LIVE_BASE_URL
        $this->connect($h, $store, 'sslcommerz', self::BKASH)->assertStatus(422);
        $this->api($h, 'PUT', $this->url($store, '/nagad'), ['mode' => 'sandbox', 'credentials' => self::SSL])->assertNotFound();

        $this->connect($h, $store, 'bkash', ['app_key' => 'invalid-key'] + self::BKASH)->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid'); // fake driver
        $this->connect($h, $store)->assertOk();
        $this->connect($h, $store, 'bkash', ['app_key' => 'second-key-abcd'] + self::BKASH)->assertOk()
            ->assertJsonPath('data.credentials_hint', '••••abcd')->assertJsonPath('data.revision', 2);
        $this->assertSame(1, $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->count()));
        $metas = $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.connected')->get()->pluck('meta.replaced')->all());
        $this->assertEqualsCanonicalizing([false, true], $metas);
    }

    public function test_enable_and_default_rules_revision_and_storefront_revalidation(): void
    {
        [, , $store, $h] = $this->liveShop();
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => true])->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');
        $this->connect($h, $store)->assertOk();
        $this->connect($h, $store, 'sslcommerz')->assertOk();

        Queue::fake([RevalidateStorefront::class]);
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 7, 'enabled' => true])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => 'yes'])->assertStatus(422);
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => true, 'is_default' => true])->assertOk()
            ->assertJsonPath('data.enabled', true)->assertJsonPath('data.is_default', true)->assertJsonPath('data.revision', 2);
        Queue::assertPushed(RevalidateStorefront::class);
        $this->api($h, 'PATCH', $this->url($store, '/sslcommerz'), ['revision' => 1, 'enabled' => true, 'is_default' => true])->assertOk()->assertJsonPath('data.is_default', true);
        $list = collect($this->api($h, 'GET', $this->url($store))->json('data'))->keyBy('provider');
        $this->assertFalse($list['bkash']['is_default'], 'one default per store');
        $this->assertSame(3, $list['bkash']['revision']);
        $this->api($h, 'PATCH', $this->url($store, '/sslcommerz'), ['revision' => 2, 'enabled' => false])->assertOk()
            ->assertJsonPath('data.enabled', false)->assertJsonPath('data.is_default', false);
    }

    public function test_test_payment_runs_through_the_fake_page_and_marks_the_account_verified(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->startTestPayment($h, $store)->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');
        $this->connect($h, $store)->assertOk();
        $this->flushHeaders()->withHeaders($h)->postJson($this->url($store, '/bkash/test-payment'))->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $key = (string) Str::uuid();
        $data = $this->startTestPayment($h, $store, 'bkash', $key)->assertCreated()->json('data');
        $this->assertSame(['payment_id', 'redirect_url'], array_keys($data));
        $this->assertSame($data, $this->startTestPayment($h, $store, 'bkash', $key)->assertCreated()->json('data'), 'idempotent replay');
        $payment = $this->inTenant($tenant, fn () => Payment::query()->findOrFail($data['payment_id']));
        $this->assertSame(['test', null, 1000, 'pending', 'charge', 'bkash'], [$payment->purpose, $payment->order_id, $payment->amount, $payment->status, $payment->type, $payment->provider]);
        $this->assertNotNull($payment->gateway_account_id);
        $this->assertStringStartsWith('FAKE', (string) $payment->provider_payment_id);

        // The fake hosted page (signed; tenant in the signature).
        $page = $this->get($data['redirect_url'])->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->assertStringContainsString('data-outcome="pay"', $page->getContent());
        $this->assertStringContainsString('৳ 10', $page->getContent());
        $this->get(str_replace('signature=', 'signature=0', $data['redirect_url']))->assertForbidden();
        preg_match('/action="([^"]+\/pay\?[^"]+)"/', $page->getContent(), $m);
        $redirect = $this->post(html_entity_decode($m[1]))->assertStatus(303)->headers->get('Location');
        $this->assertStringContainsString('/api/v1/payments/return/bkash/'.$payment->id.'?expires=', $redirect);
        $this->assertStringContainsString('paymentID='.$payment->provider_payment_id.'&status=success', $redirect);

        // What API-2's return handler then does: complete() reports success; markVerified() sets verified_at.
        $this->inTenant($tenant, function () use ($payment) {
            $account = PaymentGatewayAccount::query()->firstOrFail();
            $v = app(PaymentManager::class)->driver('bkash')->complete($payment, $account, ['status' => 'success']);
            $this->assertSame([Verification::SUCCEEDED, 1000, 'BDT', $payment->id], [$v->status, $v->amount, $v->currency, $v->reference]);
            $account->markVerified();
            $this->assertSame(1, $account->fresh()->revision, 'verification is not a merchant edit');
        });
        $this->assertNotNull($this->api($h, 'GET', $this->url($store))->json('data.0.verified_at'));
    }

    public function test_fake_outcomes_are_deterministic(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->inTenant($tenant, function () use ($store) {
            $account = $this->account($store, 'sslcommerz');
            $fake = app(FakeGateway::class);
            $run = function (int $amount, string $outcome) use ($fake, $account, $store) {
                $p = $this->payment($store, $account, $amount);
                $fake->initiate($p, $account, 'https://api.test/api/v1/payments/return/sslcommerz/'.$p->id.'?expires=1&signature=x', null);
                $this->assertSame(Verification::PENDING, $fake->query($p, $account)->status, 'nothing chosen yet');
                $target = $fake->recordOutcome($p, $outcome);
                $this->assertStringContainsString('tran_id='.$p->id, (string) $target);

                return [$p, $fake];
            };

            [$p] = $run(1000, 'pay');
            $this->assertSame(Verification::SUCCEEDED, $fake->complete($p, $account, [])->status);
            [$p] = $run(1013, 'pay');
            $this->assertSame([Verification::FAILED, 'fake_declined'], [$fake->complete($p, $account, [])->status, $fake->complete($p, $account, [])->failureCode]);
            [$p] = $run(1017, 'pay');
            $this->assertSame(1018, $fake->complete($p, $account, [])->amount, 'amount mismatch');
            [$p] = $run(1019, 'pay');
            try {
                $fake->complete($p, $account, []);
                $this->fail('19 paisa: execute timeout expected');
            } catch (GatewayException $e) {
                $this->assertSame('provider_unavailable', $e->errorCode);
            }
            $this->assertSame(Verification::SUCCEEDED, $fake->query($p, $account)->status);
            [$p] = $run(1000, 'cancel');
            $this->assertSame(Verification::CANCELLED, $fake->complete($p, $account, ['status' => 'VALID'])->status, 'return params never decide');
            [$p] = $run(1000, 'fail');
            $this->assertSame(Verification::FAILED, $fake->complete($p, $account, [])->status);

            // S22: a return with status=success but no button pressed stays pending.
            $p = $this->payment($store, $account, 1000);
            $fake->initiate($p, $account, 'https://api.test/r?x=1', null);
            $this->assertSame(Verification::PENDING, $fake->complete($p, $account, ['status' => 'success', 'val_id' => 'forged'])->status);
        });
    }

    public function test_disconnect_is_refused_while_busy_and_wipes_credentials(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->api($h, 'DELETE', $this->url($store, '/bkash'))->assertNotFound();
        $this->connect($h, $store)->assertOk();
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => true])->assertOk();
        $paymentId = $this->startTestPayment($h, $store)->assertCreated()->json('data.payment_id');

        $this->api($h, 'DELETE', $this->url($store, '/bkash'))->assertStatus(409)->assertJsonPath('error.code', 'gateway_busy');
        $this->inTenant($tenant, fn () => Payment::query()->whereKey($paymentId)->update(['status' => 'cancelled']));

        Queue::fake([RevalidateStorefront::class]);
        $this->api($h, 'DELETE', $this->url($store, '/bkash'))->assertNoContent();
        Queue::assertPushed(RevalidateStorefront::class);
        $row = $this->api($h, 'GET', $this->url($store))->json('data.0');
        $this->assertSame(['disconnected', false, false, null, null], [$row['status'], $row['enabled'], $row['is_default'], $row['credentials_hint'], $row['verified_at']]);
        $this->assertSame([], $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->firstOrFail()->credentials));
        $this->assertSame(1, $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.disconnected')->count()));
        $this->api($h, 'DELETE', $this->url($store, '/bkash'))->assertNotFound();
        $this->api($h, 'PATCH', $this->url($store, '/bkash'), ['revision' => 3, 'enabled' => true])->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');
        $this->connect($h, $store)->assertOk()->assertJsonPath('data.status', 'connected'); // reconnect keeps the route key
    }

    /** S38 + foreign ids. */
    #[Group('security')]
    public function test_staff_can_read_but_not_write_and_foreign_stores_are_404(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->connect($h, $store)->assertOk();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);

        $read = $this->api($staff, 'GET', $this->url($store))->assertOk();
        foreach (self::BKASH as $secret) {
            $this->assertStringNotContainsString($secret, $read->getContent());
        }
        $this->connect($staff, $store)->assertForbidden();
        $this->api($staff, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => true])->assertForbidden();
        $this->startTestPayment($staff, $store)->assertForbidden();
        $this->api($staff, 'DELETE', $this->url($store, '/bkash'))->assertForbidden();
        $this->api($admin, 'PATCH', $this->url($store, '/bkash'), ['revision' => 1, 'enabled' => true])->assertOk();

        [, , $storeB] = $this->liveShop('bravo');
        $this->assertTenantIsolation($h, [
            ['GET', $this->url($storeB)],
            ['PUT', $this->url($storeB, '/bkash'), ['mode' => 'sandbox', 'credentials' => self::BKASH]],
            ['PATCH', $this->url($storeB, '/bkash'), ['revision' => 1, 'enabled' => true]],
            ['DELETE', $this->url($storeB, '/bkash')],
        ]);
    }

    #[Group('tenancy')]
    public function test_new_payment_models_are_isolated_by_tenant_and_store(): void
    {
        [, $ta, $sa, $ha] = $this->liveShop('alpha');
        [, $tb, $sb, $hb] = $this->liveShop('bravo');
        foreach ([[$ta, $sa, $ha], [$tb, $sb, $hb]] as [$tenant, $store, $h]) {
            $this->seedPaymentRows($tenant, $store, $h);
        }
        foreach ([PaymentGatewayAccount::class, PaymentLink::class, WebhookEvent::class] as $model) {
            $this->assertStoreIsolation($model, $ta, $sa, $sb);
            $this->assertStoreIsolation($model, $tb, $sb, $sa);
            $this->inTenant($ta, fn () => $this->assertSame(1, $model::query()->count(), $model));
        }
    }

    // ---------------------------------------------------------------- helpers

    private function account(Store $store, string $provider): PaymentGatewayAccount
    {
        $a = new PaymentGatewayAccount;
        $a->store_id = $store->id;
        $a->provider = $provider;
        $a->mode = 'sandbox';
        $a->status = 'connected';
        $a->credentials = $provider === 'bkash' ? self::BKASH : self::SSL;
        $a->route_key = PaymentGatewayAccount::newRouteKey();
        $a->save();

        return $a;
    }

    private function payment(Store $store, PaymentGatewayAccount $account, int $amount): Payment
    {
        $p = new Payment;
        $p->store_id = $store->id;
        $p->provider = $account->provider;
        $p->type = 'charge';
        $p->status = 'pending';
        $p->purpose = 'test';
        $p->amount = $amount;
        $p->currency = 'BDT';
        $p->gateway_account_id = $account->id;
        $p->save();

        return $p;
    }

    private function seedPaymentRows(Tenant $tenant, Store $store, array $h): void
    {
        [, $variant] = $this->stocked($h, $store);
        $orderId = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data.id');
        $this->inTenant($tenant, function () use ($store, $orderId) {
            $account = $this->account($store, 'bkash');
            $link = new PaymentLink;
            $link->store_id = $store->id;
            $link->order_id = $orderId;
            $link->token_hash = PaymentLink::hashToken(Str::random(12));
            $link->token_encrypted = 'x';
            $link->amount_kind = 'full';
            $link->amount = 1000;
            $link->provider = 'bkash';
            $link->expires_at = now()->addHours(2);
            $link->cancel_if_unpaid = true;
            $link->save();
            $event = new WebhookEvent;
            $event->store_id = $store->id;
            $event->provider = 'sslcommerz';
            $event->account_id = $account->id;
            $event->event_id = 'val-'.Str::random(8);
            $event->payload = ['status' => 'VALID'];
            $event->received_at = now();
            $event->save();
        });
    }

    /** @return array<string, mixed> */
    private function fixture(string $name): array
    {
        return json_decode((string) file_get_contents(base_path("tests/Fixtures/payments/{$name}.json")), true, 512, JSON_THROW_ON_ERROR);
    }
}
