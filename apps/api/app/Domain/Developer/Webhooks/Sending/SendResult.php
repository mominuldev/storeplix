<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/** Outcome of one attempt (P84-10): ok = 2xx; errorCode one of timeout|connection_failed|url_not_allowed|http_error. */
final readonly class SendResult
{
    public function __construct(
        public bool $ok,
        public ?int $status,
        public ?string $body,
        public ?string $errorCode,
        public int $durationMs,
    ) {}

    public static function response(int $status, ?string $body, int $durationMs): self
    {
        $ok = $status >= 200 && $status < 300;

        return new self($ok, $status, $body, $ok ? null : 'http_error', $durationMs);
    }

    public static function error(string $code, int $durationMs): self
    {
        return new self(false, null, null, $code, $durationMs);
    }
}
