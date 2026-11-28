<?php

declare(strict_types=1);

namespace Tests\Unit\Integrations;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Integrations\PublicEndpointGuard;
use App\Domain\Integrations\PublicHostResolver;
use App\Domain\Integrations\Settings\MetaPixelSettings;
use App\Domain\Integrations\Settings\ProviderSettings;
use App\Domain\Tracking\Drivers\DeliveryResult;
use App\Domain\Tracking\TrackingEventNames;
use App\Domain\Tracking\TrackingTestMode;
use App\Domain\Tracking\UserDataHasher;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D unit rules: hashing vectors (P89D-13), the retry schedule (P89D-15), pasted-code detection (P89D-6),
 * event names (§5.1), hints (P89D-7), the endpoint guard (P89D-17) and the test-mode token (P89D-19).
 */
#[Group('integrations')]
#[Group('tracking')]
class TrackingRulesTest extends TestCase
{
    public function test_hashing_vectors(): void
    {
        $this->assertSame(hash('sha256', 'rafi@example.com'), UserDataHasher::email('  Rafi@Example.COM '));
        $this->assertNull(UserDataHasher::email('not-an-email'));
        $this->assertNull(UserDataHasher::email(''));
        foreach (['01711000001', '+8801711000001', '8801711000001', '01711-000001'] as $phone) {
            $this->assertSame(hash('sha256', '+8801711000001'), UserDataHasher::phone($phone), $phone);
            $this->assertSame(hash('sha256', '8801711000001'), UserDataHasher::metaPhone($phone), $phone);
        }
        $this->assertNull(UserDataHasher::phone('12345'));
        $this->assertSame(hash('sha256', 'coxsbazar'), UserDataHasher::name(' Coxs  Bazar '));
        $user = UserDataHasher::forOrder(null, '01711000001', 'Nusrat  Jahan Mim', null, null);
        $this->assertSame(['ph', 'ph_meta', 'fn', 'ln', 'country'], array_keys($user));
        $this->assertSame([hash('sha256', 'nusrat'), hash('sha256', 'mim'), hash('sha256', 'bd')], [$user['fn'], $user['ln'], $user['country']]);
        $this->assertSame(64, strlen((string) UserDataHasher::forOrder('a@b.co', null, 'X', 'Dhaka', 'cust')['external_id']));
    }

    public function test_retry_schedule_is_five_attempts_inside_24_hours(): void
    {
        $this->assertSame(5, config('tracking.max_attempts'));
        $delays = array_slice((array) config('tracking.retry_delays'), 0, 4);
        $this->assertSame([60, 600, 3600, 21600], $delays);
        $this->assertLessThan(86400, array_sum($delays) + 57600);
        $this->assertTrue(DeliveryResult::fail(DeliveryResult::RATE_LIMITED)->retryable());
        $this->assertTrue(DeliveryResult::fail(DeliveryResult::UNAVAILABLE)->retryable());
        $this->assertTrue(DeliveryResult::fail(DeliveryResult::TIMEOUT)->retryable());
        $this->assertFalse(DeliveryResult::fail(DeliveryResult::AUTH)->retryable());
        $this->assertFalse(DeliveryResult::fail(DeliveryResult::REJECTED)->retryable());
        $this->assertFalse(DeliveryResult::fail(DeliveryResult::BLOCKED)->retryable());
        $this->assertFalse(DeliveryResult::ok()->retryable());
    }

    public function test_pasted_code_detection_and_defaults(): void
    {
        foreach (["<script>fbq('init')</script>", "fbq('track','PageView')", "gtag('config','G-X')", 'ttq.page()', 'https://www.googletagmanager.com/gtm.js?id=GTM-X',
            '!function(f,b){}', '< SCRIPT src=x>', '<iframe src=x>', '<img src=x>'] as $code) {
            $this->assertTrue(ProviderSettings::looksLikeCode($code), $code);
        }
        foreach (['1234567890123456', 'G-ABC123', 'C0ABCDEFGHIJ12345678', 'GTM-ABCD12', 'https://sgtm.example.com'] as $id) {
            $this->assertFalse(ProviderSettings::looksLikeCode($id), $id);
        }
        $this->assertSame(['pixel_id' => '123456789012'] + MetaPixelSettings::defaults(), MetaPixelSettings::validate(['pixel_id' => ' 1234 5678 9012 '], []));
        $this->assertSame('123456789012', MetaPixelSettings::validate(['pixel_id' => ' 1234 5678 9012 '], [])['pixel_id']);
    }

    public function test_event_names_and_hints(): void
    {
        $this->assertSame('CompletePayment', TrackingEventNames::for('tiktok_pixel', 'purchase'));
        $this->assertSame('Pageview', TrackingEventNames::for('tiktok_pixel', 'page_view'));
        $this->assertNull(TrackingEventNames::for('meta_pixel', 'refund'));
        $this->assertSame('refund', TrackingEventNames::for('ga4', 'refund'));
        $this->assertSame('••••abcd', IntegrationCredentials::hint('secret-value-abcd'));
    }

    #[Group('security')]
    public function test_public_endpoint_guard(): void
    {
        foreach (['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.1', '172.16.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.8'] as $ip) {
            $this->assertFalse(PublicEndpointGuard::isPublicIp($ip), $ip);
        }
        $this->assertTrue(PublicEndpointGuard::isPublicIp('93.184.216.34'));
        foreach (['http://a.example.com', 'https://1.2.3.4', 'https://[::1]', 'https://localhost', 'https://box.local', 'https://intranet', 'https://a.example.com:444', 'https://u@a.example.com'] as $url) {
            try {
                PublicEndpointGuard::assertAcceptable($url);
                $this->fail("{$url} accepted");
            } catch (InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        PublicEndpointGuard::assertAcceptable('https://a.example.com:443/path');
        PublicEndpointGuard::assertAcceptable('https://a.example.com:8443', only443: false); // SMS keeps any port (8.9b)
        $guard = new PublicEndpointGuard(new class extends PublicHostResolver
        {
            public function resolve(string $host): array
            {
                return ['93.184.216.34'];
            }
        });
        $this->assertSame(['a.example.com:443:93.184.216.34'], $guard->pin('https://a.example.com'));
    }

    public function test_test_mode_token_is_signed_scoped_and_expires(): void
    {
        $token = TrackingTestMode::token('store1', 'int1', now()->addMinutes(30)->getTimestamp());
        $this->assertSame('int1', TrackingTestMode::integrationFor($token, 'store1'));
        $this->assertNull(TrackingTestMode::integrationFor($token, 'store2'));
        [$body, $mac] = explode('.', $token);
        $forged = rtrim(strtr(base64_encode((string) json_encode(['s' => 'store1', 'i' => 'int2', 'e' => now()->addDay()->getTimestamp()])), '+/', '-_'), '=');
        $this->assertNull(TrackingTestMode::integrationFor($forged.'.'.$mac, 'store1'));
        $this->assertNull(TrackingTestMode::integrationFor(TrackingTestMode::token('store1', 'int1', now()->subSecond()->getTimestamp()), 'store1'));
        $this->assertNull(TrackingTestMode::integrationFor(null, 'store1'));
        $this->assertNull(TrackingTestMode::integrationFor($body, 'store1'));
    }
}
