<?php

declare(strict_types=1);

namespace App\Domain\Sms\Routing;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Sms\Drivers\CannedSmsDriver;
use App\Domain\Sms\Drivers\HttpDriver;
use App\Domain\Sms\Drivers\RevesmsDriver;
use App\Domain\Sms\Drivers\RevesmsGateway;
use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\Providers\SmsProviderDriver;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Contracts\Encryption\DecryptException;
use SensitiveParameter;

/**
 * Builds the driver and the short-lived connection of a provider (PHASE-8-9B §4.1). `SMS_PROVIDERS_HTTP_FAKE=true`
 * swaps every driver for the canned one (S231: refused at boot in production).
 */
final class SmsDriverFactory
{
    public function __construct(private readonly IntegrationCredentials $crypto) {}

    public function driver(string $code): SmsProviderDriver
    {
        if ((bool) config('sms.providers_http_fake')) {
            return new CannedSmsDriver;
        }

        return match ($code) {
            'revesms' => app(RevesmsDriver::class),
            'http' => app(HttpDriver::class),
            default => throw new SmsSendFailed('This SMS provider driver is not available yet.', SmsSendFailed::UNAVAILABLE, null, 'Driver not available'),
        };
    }

    public function connection(ProviderRoute $route): SmsConnection
    {
        if ($route->environment) {
            return RevesmsGateway::connectionFrom((array) config('sms.revesms', []));
        }
        try {
            $credentials = $this->crypto->decrypt((string) $route->ciphertext);
        } catch (DecryptException) {
            throw new SmsSendFailed('The provider credentials could not be read.', SmsSendFailed::AUTH, $route->id, 'Credentials unreadable');
        }

        return self::connect($credentials, $route->settings, $route->timeoutSeconds, $route->id);
    }

    /**
     * @param  array<string, mixed>  $credentials
     * @param  array<string, mixed>  $settings
     */
    public static function connect(#[SensitiveParameter] array $credentials, array $settings, int $timeout, ?string $providerId): SmsConnection
    {
        return new SmsConnection(array_map(fn ($v) => (string) $v, $credentials), $settings, $timeout, $providerId, false, 0);
    }
}
