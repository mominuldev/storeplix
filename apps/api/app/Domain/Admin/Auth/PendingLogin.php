<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use Illuminate\Support\Carbon;

/**
 * A password-verified admin sign-in waiting for its TOTP step (PHASE-8-1 §3.1). Lives only in the cache, as a plain
 * array (`cache.serializable_classes` is off).
 */
final class PendingLogin
{
    public function __construct(
        public readonly string $key,
        public readonly string $userId,
        public readonly string $ip,
        public readonly string $step,
        public readonly Carbon $expiresAt,
        public int $failures = 0,
        /** Encrypted secret handed out by GET /admin/auth/enroll (step `enroll` only). */
        public ?string $enrollSecret = null,
    ) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'key' => $this->key, 'user_id' => $this->userId, 'ip' => $this->ip, 'step' => $this->step,
            'expires_at' => $this->expiresAt->getTimestamp(), 'failures' => $this->failures, 'enroll_secret' => $this->enrollSecret,
        ];
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            (string) $data['key'], (string) $data['user_id'], (string) $data['ip'], (string) $data['step'],
            Carbon::createFromTimestamp((int) $data['expires_at']), (int) $data['failures'],
            isset($data['enroll_secret']) ? (string) $data['enroll_secret'] : null,
        );
    }
}
