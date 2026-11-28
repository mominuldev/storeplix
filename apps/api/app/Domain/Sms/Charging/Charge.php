<?php

declare(strict_types=1);

namespace App\Domain\Sms\Charging;

use App\Domain\Sms\Models\SmsMessage;

/** The outcome of SmsCharger::charge() (PHASE-8-9A §4.2). `from` null = skipped (`no_credits`). */
final readonly class Charge
{
    public function __construct(
        public ?string $from,
        public int $parts,
        public int $credits,
        public ?int $allowanceRemaining,
        public int $balance,
    ) {}

    public function skipped(): bool
    {
        return $this->from === null;
    }

    public static function fromRow(SmsMessage $row, int $balance): self
    {
        return new self($row->status === SmsMessage::SKIPPED ? null : $row->charged_from, (int) ($row->parts ?? 0), (int) $row->credits_charged, null, $balance);
    }
}
