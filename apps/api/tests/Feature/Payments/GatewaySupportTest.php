<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Payments\GatewaysServiceProvider;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\CommerceFixtures;
use Tests\Support\PaymentGatewayFixtures;
use Tests\TestCase;

/** 5b-2 gateway plumbing: Money decimal bridge, PayloadScrubber, IntegrationCredentials + rotation, fake boot check, S27. */
#[Group('payments')]
class GatewaySupportTest extends TestCase
{
    use CommerceFixtures, PaymentGatewayFixtures, RefreshDatabase;

    public function test_money_decimal_bridge_is_exact_and_strict(): void
    {
        $this->assertSame(['1770.00', '0.05', '0.00', '1770.50', '-12.34', '92233720368547758.07'],
            [Money::toDecimal(177000), Money::toDecimal(5), Money::toDecimal(0), Money::toDecimal(177050), Money::toDecimal(-1234), Money::toDecimal(PHP_INT_MAX)]);
        $this->assertSame([177000, 177000, 177050, 177005, 1, -1234], [Money::fromDecimal('1770'), Money::fromDecimal('1770.00'),
            Money::fromDecimal('1770.5'), Money::fromDecimal(' 1770.05 '), Money::fromDecimal('0.01'), Money::fromDecimal('-12.34')]);
        foreach (['1770.001', '1,770.00', '1e3', '', '.5', '+5', '17 70', 'NaN', '1770.'] as $bad) {
            $this->assertNull(Money::tryFromDecimal($bad), $bad);
            try {
                Money::fromDecimal($bad);
                $this->fail("accepted {$bad}");
            } catch (InvalidArgumentException) {
            }
        }
        $this->assertSame(50000, Money::tryFromDecimal(500));
        $this->assertNull(Money::tryFromDecimal(500.5), 'floats are never trusted');
        $this->assertNull(Money::tryFromDecimal(null));
    }

    public function test_payload_scrubber_removes_secrets_cards_and_pii_at_any_depth(): void
    {
        $out = PayloadScrubber::scrub([
            'status' => 'VALID', 'amount' => '10.00', 'tran_id' => 'T', 'risk_level' => '1', 'bank_tran_id' => 'B',
            'id_token' => 'eyJ', 'store_passwd' => 'p', 'card_no' => '4111XXXXXX1111', 'cus_phone' => '017', 'verify_sign' => 'x',
            'nested' => [['customerMsisdn' => '017', 'trxID' => 'TRX', 'Authorization' => 'Bearer t']],
        ]);
        $this->assertSame(['VALID', '10.00', 'T', '1', 'B', 'TRX'], [$out['status'], $out['amount'], $out['tran_id'], $out['risk_level'], $out['bank_tran_id'], $out['nested'][0]['trxID']]);
        foreach (['id_token', 'store_passwd', 'card_no', 'cus_phone', 'verify_sign'] as $k) {
            $this->assertSame('[redacted]', $out[$k], $k);
        }
        $this->assertSame(['[redacted]', '[redacted]'], [$out['nested'][0]['customerMsisdn'], $out['nested'][0]['Authorization']]);
    }

    public function test_credentials_use_the_dedicated_key_and_rotate(): void
    {
        $old = 'base64:'.base64_encode(random_bytes(32));
        $new = 'base64:'.base64_encode(random_bytes(32));
        config(['integrations.key' => $old, 'integrations.previous_keys' => '']);
        $this->app->forgetInstance(IntegrationCredentials::class);
        [, $tenant, $store] = $this->liveShop();
        $this->inTenant($tenant, fn () => $this->gatewayAccount($store, 'sslcommerz', ['store_id' => 'abc', 'store_passwd' => 'secret-pass']));
        $cipher = (string) $this->platformTable('payment_gateway_accounts')->value('credentials');
        $this->assertStringNotContainsString('secret-pass', $cipher);
        try {
            decrypt($cipher, false);
            $this->fail('readable with APP_KEY');
        } catch (DecryptException) {
            // the dedicated key only (P5B-10)
        }

        // New key without the previous one: unreadable.
        config(['integrations.key' => $new]);
        $this->app->forgetInstance(IntegrationCredentials::class);
        try {
            app(IntegrationCredentials::class)->decrypt($cipher);
            $this->fail('decrypted without the old key');
        } catch (DecryptException) {
        }

        // New key + previous: readable, then rotate-key rewrites with the new key.
        config(['integrations.previous_keys' => $old]);
        $this->app->forgetInstance(IntegrationCredentials::class);
        $this->assertSame('secret-pass', $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->firstOrFail()->credentials['store_passwd']));
        $this->assertFalse(app(IntegrationCredentials::class)->isCurrent($cipher));
        $this->artisan('integrations:rotate-key', ['--dry-run' => true])->assertSuccessful();
        $this->assertSame($cipher, (string) $this->platformTable('payment_gateway_accounts')->value('credentials'));
        $this->artisan('integrations:rotate-key')->expectsOutputToContain('payment_gateway_accounts.credentials: 1 re-encrypted')->assertSuccessful();
        $rotated = (string) $this->platformTable('payment_gateway_accounts')->value('credentials');
        $this->assertTrue(app(IntegrationCredentials::class)->isCurrent($rotated));
        config(['integrations.previous_keys' => '']);
        $this->app->forgetInstance(IntegrationCredentials::class);
        $this->assertSame(['store_id' => 'abc', 'store_passwd' => 'secret-pass'], app(IntegrationCredentials::class)->decrypt($rotated));
        $this->assertSame('••••3f9a', IntegrationCredentials::hint('appkey-3f9a'));
        $this->assertSame('••••', IntegrationCredentials::hint('abc'));
    }

    public function test_fake_payments_refuse_to_boot_in_production(): void
    {
        config(['payments.fake' => true]);
        $this->app['env'] = 'production';
        try {
            GatewaysServiceProvider::assertSafeConfiguration($this->app);
            $this->fail('PAYMENTS_FAKE=true booted in production');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('PAYMENTS_FAKE', $e->getMessage());
        } finally {
            $this->app['env'] = 'testing';
        }
        config(['payments.fake' => false]);
        $this->app['env'] = 'production';
        GatewaysServiceProvider::assertSafeConfiguration($this->app);
        $this->app['env'] = 'testing';
        $this->addToAssertionCount(1);
    }

    #[Group('security')]
    public function test_outbound_base_urls_must_be_public_https(): void
    {
        SafeHttpClient::assertSafeBaseUrl('https://tokenized.sandbox.bka.sh/v2/tokenized-checkout');
        foreach (['http://sandbox.sslcommerz.com', 'https://169.254.169.254/latest', 'https://10.0.0.5', 'https://127.0.0.1', 'https://localhost', 'https://user:pw@sandbox.sslcommerz.com', 'ftp://x'] as $bad) {
            try {
                SafeHttpClient::assertSafeBaseUrl($bad);
                $this->fail("allowed {$bad}");
            } catch (InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_manage_integrations_is_owner_and_admin_only(): void
    {
        $this->assertSame([TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN], Permission::ManageIntegrations->roles());
        $this->assertFalse(Permission::ManageIntegrations->grantedTo(TenantUser::ROLE_STAFF));
    }
}
