<?php

namespace App\Domain\Sms;

final readonly class SmsResult
{
    /**
     * @param  array<string, mixed>  $raw  provider response (never contains our credentials)
     * @param  string|null  $provider_id  PHASE-8-9B §4.3: the `sms_providers` row that accepted it (null = environment / log / fake)
     * @param  string|null  $failover_error_code  set when the first candidate failed and a later one accepted (P89B-27 "failed over")
     * @param  string|null  $failover_detail  the first candidate's redacted error text (staff only)
     */
    public function __construct(
        public ?string $message_id,
        public bool $accepted,
        public array $raw = [],
        public ?string $provider_id = null,
        public ?int $latency_ms = null,
        public ?string $failover_error_code = null,
        public ?string $failover_detail = null,
    ) {}

    public function withRoute(?string $providerId, ?int $latencyMs, ?string $failoverErrorCode = null, ?string $failoverDetail = null): self
    {
        return new self($this->message_id, $this->accepted, $this->raw, $providerId, $latencyMs, $failoverErrorCode, $failoverDetail);
    }
}
