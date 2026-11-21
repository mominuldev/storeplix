<?php

namespace App\Domain\Sms;

final readonly class SmsResult
{
    /**
     * @param  array<string, mixed>  $raw  provider response (never contains our credentials)
     */
    public function __construct(
        public ?string $message_id,
        public bool $accepted,
        public array $raw = [],
    ) {}
}
