<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

/**
 * Outcome of one provider call (PHASE-8-9D §5.2). `errorCode` is a TrackingErrorCode (auth | rejected | rate_limited |
 * provider_unavailable | timeout | endpoint_blocked). `providerMessage` is redacted (no tokens) and ≤ 200 chars; it is
 * shown only in a test result, never stored.
 */
final class DeliveryResult
{
    public const AUTH = 'auth';

    public const REJECTED = 'rejected';

    public const RATE_LIMITED = 'rate_limited';

    public const UNAVAILABLE = 'provider_unavailable';

    public const TIMEOUT = 'timeout';

    public const BLOCKED = 'endpoint_blocked';

    /** @param list<string> $validationMessages */
    public function __construct(
        public readonly bool $delivered,
        public readonly ?int $httpStatus = null,
        public readonly ?string $errorCode = null,
        public readonly ?int $retryAfter = null,
        public readonly ?string $providerMessage = null,
        public readonly array $validationMessages = [],
        public readonly ?string $foundName = null,
    ) {}

    public static function ok(?int $status = 200, ?string $foundName = null): self
    {
        return new self(true, $status, foundName: $foundName);
    }

    public static function fail(string $code, ?int $status = null, ?string $message = null, ?int $retryAfter = null): self
    {
        return new self(false, $status, $code, $retryAfter, $message);
    }

    /** Worth another attempt later (P89D-15). Auth failures and rejections are final. */
    public function retryable(): bool
    {
        return ! $this->delivered && in_array($this->errorCode, [self::RATE_LIMITED, self::UNAVAILABLE, self::TIMEOUT], true);
    }
}
