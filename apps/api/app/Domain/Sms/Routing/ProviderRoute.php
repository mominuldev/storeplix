<?php

declare(strict_types=1);

namespace App\Domain\Sms\Routing;

use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\SmsRoute;

/**
 * One routing candidate (PHASE-8-9B §4.3): a database provider row (cached; credentials stay ciphertext here) or the
 * environment REVE account (`id` null, `environment` true).
 */
final readonly class ProviderRoute
{
    /** @param list<string> $groups */
    public function __construct(
        public ?string $id,
        public string $name,
        public string $driver,
        public string $role,
        public array $groups,
        public string $defaultSender,
        public ?string $promotionalSender,
        public ?string $promotionalStatus,
        public int $failAfter,
        public int $timeoutSeconds,
        public int $rateLimitPerMinute,
        public ?string $ciphertext,
        /** @var array<string, mixed> */
        public array $settings,
        public bool $environment = false,
    ) {}

    public static function fromModel(SmsProvider $p): self
    {
        return new self($p->id, $p->name, $p->driver, $p->role, array_values((array) $p->message_groups), $p->default_sender_id,
            $p->promotional_sender_id, $p->promotional_sender_status, (int) $p->failover_after_failures, (int) $p->failover_timeout_seconds,
            (int) $p->rate_limit_per_minute, $p->credentials_encrypted, (array) $p->settings);
    }

    /** @param array<string, mixed> $config config('sms.revesms') */
    public static function environment(array $config): self
    {
        return new self(null, 'REVE SMS (server environment)', 'revesms', SmsProvider::PRIMARY, SmsRoute::values(),
            (string) ($config['caller_id'] ?? ''), null, null, 3, (int) ($config['timeout'] ?? 10), 300, null,
            ['base_url' => (string) ($config['base_url'] ?? ''), 'account_id' => null], true);
    }

    public function carries(string $group): bool
    {
        return in_array($group, $this->groups, true);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return get_object_vars($this);
    }

    /** @param array<string, mixed> $a */
    public static function fromArray(array $a): self
    {
        return new self(...$a);
    }
}
