<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use PHPUnit\Framework\Attributes\Group;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

/**
 * PHASE-8-9A standing rule + §15 static test: no code calls the SMS gateway for a tenant message without a charged
 * `sms_messages` row. The gateway is only used by the drivers, the account-code job (platform-paid) and the
 * charger-aware senders; every caller of CampaignMessenger::sms goes through SmsCharger too.
 */
#[Group('sms')]
#[Group('security')]
class SmsChargerArchTest extends TestCase
{
    /** Files allowed to resolve / call the SmsGateway. Charger-aware senders must also reference SmsCharger. */
    private const GATEWAY_USERS = [
        'app/Domain/Sms/SmsGateway.php' => false,
        'app/Domain/Sms/SmsServiceProvider.php' => false,
        'app/Domain/Sms/Drivers/FakeSmsGateway.php' => false,
        'app/Domain/Sms/Drivers/LogSmsGateway.php' => false,
        'app/Domain/Sms/Drivers/RevesmsGateway.php' => false,
        'app/Domain/Sms/Jobs/SendSms.php' => false, // account codes (otp_*): platform-paid, never charged
        'app/Domain/Marketing/Sending/CampaignMessenger.php' => false, // its callers are checked below
        'app/Domain/Orders/Notifications/SendOrderSms.php' => true,
        'app/Domain/FraudGuard/Jobs/SendCheckoutOtp.php' => true,
        'app/Domain/Sms/SmsTestService.php' => true,
        // PHASE-8-9B: the router itself and the platform SMS senders (platform-paid, never charged).
        'app/Domain/Sms/Routing/RoutingSmsGateway.php' => false,
        'app/Domain/Sms/Platform/PlatformSmsDelivery.php' => false,
        'app/Domain/Sms/Platform/PlatformSmsMessageTypes.php' => false,
        'app/Domain/Sms/Jobs/SendPlatformSms.php' => false,
        'app/Domain/Sms/Broadcasts/Jobs/SendPlatformBroadcastBatch.php' => false,
    ];

    public function test_only_charger_aware_code_reaches_the_sms_gateway(): void
    {
        $offenders = [];
        foreach ((new Finder)->files()->name('*.php')->in(base_path('app')) as $file) {
            $path = str_replace(base_path().'/', '', $file->getRealPath());
            $code = $file->getContents();
            if (preg_match('/\bSmsGateway\b/', $code) === 1) {
                if (! array_key_exists($path, self::GATEWAY_USERS)) {
                    $offenders[] = "{$path}: uses SmsGateway";
                } elseif (self::GATEWAY_USERS[$path] && ! str_contains($code, 'SmsCharger')) {
                    $offenders[] = "{$path}: sends without SmsCharger";
                }
            }
            if (preg_match('/messenger->sms\(/', $code) === 1 && ! str_contains($code, 'SmsCharger')) {
                $offenders[] = "{$path}: campaign SMS without SmsCharger";
            }
        }

        $this->assertSame([], $offenders);
    }
}
