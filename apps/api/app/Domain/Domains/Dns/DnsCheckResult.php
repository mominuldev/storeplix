<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

use App\Domain\Domains\DomainFailureCode;
use Carbon\CarbonInterface;

/** Outcome of the TXT + routing check of one host across the resolvers (P6-2, P6-3). */
final readonly class DnsCheckResult
{
    public const OK = 'ok';

    public const FAIL = 'fail';

    public const INCONCLUSIVE = 'inconclusive';

    /**
     * @param  array{status: string, found: list<string>}  $ownership  status ok|missing|mismatch|pending (pending = inconclusive)
     * @param  array{status: string, found: list<string>, mode: string}  $routing
     * @param  array<string, string>  $resolvers  resolver name → ok|error
     */
    public function __construct(
        public string $outcome,
        public array $ownership,
        public array $routing,
        public array $resolvers,
    ) {}

    public function passed(): bool
    {
        return $this->outcome === self::OK;
    }

    public function inconclusive(): bool
    {
        return $this->outcome === self::INCONCLUSIVE;
    }

    public function failureCode(): ?DomainFailureCode
    {
        return match (true) {
            $this->outcome === self::OK => null,
            $this->outcome === self::INCONCLUSIVE => DomainFailureCode::DnsError,
            $this->ownership['status'] === 'missing' => DomainFailureCode::TxtMissing,
            $this->ownership['status'] === 'mismatch' => DomainFailureCode::TxtMismatch,
            $this->routing['status'] === 'missing' => DomainFailureCode::CnameMissing,
            default => DomainFailureCode::CnameMismatch,
        };
    }

    /**
     * The `last_check` jsonb (§3.1). An inconclusive check keeps the previous per-record observations.
     *
     * @param  array<string, mixed>|null  $previous
     * @return array<string, mixed>
     */
    public function toLastCheck(CarbonInterface $now, ?array $previous = null): array
    {
        $records = ['ownership' => $this->ownership, 'routing' => $this->routing];
        if ($this->inconclusive() && is_array($previous['records'] ?? null)) {
            $records = $previous['records'];
        }

        return [
            'checked_at' => $now->toIso8601ZuluString(),
            'outcome' => $this->outcome,
            'records' => $records,
            'resolvers' => $this->resolvers,
        ];
    }
}
