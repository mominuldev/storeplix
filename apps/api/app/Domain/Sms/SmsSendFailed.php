<?php

namespace App\Domain\Sms;

use RuntimeException;
use Throwable;

/**
 * A send that did not go out. PHASE-8-9B §4.1: `reason` tells the router what to do — `unavailable` / `auth` (the
 * provider certainly did not accept it: try the next candidate, count toward the breaker), `timeout` (it may have been
 * accepted: never retried, opens the breaker), `rejected` (message-level: no retry, no breaker count). `detail` is
 * already redacted (no credentials); messages never carry a credential either.
 */
class SmsSendFailed extends RuntimeException
{
    public const REJECTED = 'rejected';

    public const UNAVAILABLE = 'unavailable';

    public const TIMEOUT = 'timeout';

    public const AUTH = 'auth';

    /** §3.2 `sms_messages.error_code` values of 8.9b (merchant outputs map them all to `provider_error`). */
    public const PROVIDER_ERROR = 'provider_error';

    public const PROVIDER_UNAVAILABLE = 'provider_unavailable';

    public const PROVIDER_TIMEOUT = 'provider_timeout';

    public const PROVIDER_AUTH = 'provider_auth';

    public const NO_ROUTE = 'no_route';

    public function __construct(
        string $message = '',
        public readonly string $reason = self::REJECTED,
        public readonly ?string $providerId = null,
        public readonly ?string $detail = null,
        private readonly ?string $code_ = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    /** Our stable error code for this failure. */
    public function errorCode(): string
    {
        return $this->code_ ?? match ($this->reason) {
            self::UNAVAILABLE => self::PROVIDER_UNAVAILABLE,
            self::TIMEOUT => self::PROVIDER_TIMEOUT,
            self::AUTH => self::PROVIDER_AUTH,
            default => self::PROVIDER_ERROR,
        };
    }

    /** Provider-level failure (counts toward the breaker, may go to the next candidate / be retried later). */
    public function providerLevel(): bool
    {
        return in_array($this->reason, [self::UNAVAILABLE, self::AUTH], true);
    }

    public function withProvider(?string $providerId): self
    {
        return new self($this->getMessage(), $this->reason, $providerId, $this->detail, $this->code_, $this->getPrevious());
    }

    public static function noRoute(string $message = 'No SMS provider can carry this message.'): self
    {
        return new self($message, self::UNAVAILABLE, null, $message, self::NO_ROUTE);
    }
}
