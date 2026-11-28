<?php

namespace App\Domain\Sms\Drivers;

use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsRoute;

/**
 * The environment REVE account (`REVESMS_*`) as a gateway: PHASE-8-9B P89B-2 bootstrap while no database primary
 * exists. All request/response handling lives in RevesmsDriver; this adapter only builds the trusted connection from
 * config (caller ID = `REVESMS_CALLER_ID` unless a masked sender is given).
 */
class RevesmsGateway implements SmsGateway
{
    /**
     * @param  array{base_url: string, api_key: ?string, secret_key: ?string, caller_id: ?string, timeout?: int, retries?: int}  $config
     */
    public function __construct(private readonly array $config) {}

    public static function connectionFrom(array $config): SmsConnection
    {
        return new SmsConnection(
            ['api_key' => (string) ($config['api_key'] ?? ''), 'secret_key' => (string) ($config['secret_key'] ?? '')],
            ['base_url' => (string) ($config['base_url'] ?? ''), 'account_id' => null],
            (int) ($config['timeout'] ?? 10),
            null,
            trusted: true,
            connectRetries: (int) ($config['retries'] ?? 2),
        );
    }

    public function send(string $msisdn, string $text, ?string $senderId = null, SmsRoute $route = SmsRoute::Shop): SmsResult
    {
        return (new RevesmsDriver)->send(self::connectionFrom($this->config), $msisdn, $text, $senderId ?? (string) ($this->config['caller_id'] ?? ''));
    }

    public function status(string $messageId): array
    {
        return (new RevesmsDriver)->status(self::connectionFrom($this->config), $messageId);
    }
}
