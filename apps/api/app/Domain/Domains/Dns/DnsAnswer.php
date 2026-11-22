<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

/** One resolver's answer to one (name, type) question (§5.1). */
final readonly class DnsAnswer
{
    public const OK = 'ok';

    public const NXDOMAIN = 'nxdomain';

    public const ERROR = 'error';

    public const TYPES = ['A' => 1, 'CNAME' => 5, 'TXT' => 16, 'AAAA' => 28];

    /** @param list<array{type: int, data: string}> $records */
    public function __construct(public string $status, public array $records = []) {}

    /** @param list<array{type: int, data: string}> $records */
    public static function ok(array $records): self
    {
        return new self(self::OK, $records);
    }

    public static function nxdomain(): self
    {
        return new self(self::NXDOMAIN);
    }

    public static function error(): self
    {
        return new self(self::ERROR);
    }

    public function isError(): bool
    {
        return $this->status === self::ERROR;
    }

    /**
     * Normalised values of one record type: TXT quote-stripped and joined, CNAME lowercase without the trailing dot.
     *
     * @return list<string>
     */
    public function values(string $type): array
    {
        $code = self::TYPES[$type] ?? -1;
        $out = [];
        foreach ($this->records as $record) {
            if ((int) $record['type'] !== $code) {
                continue;
            }
            $data = trim((string) $record['data']);
            $out[] = match ($type) {
                'TXT' => self::txt($data),
                'CNAME' => strtolower(rtrim($data, '.')),
                default => strtolower($data),
            };
        }

        return array_values(array_unique($out));
    }

    /** `"sp-verify=abc" "def"` → `sp-verify=abcdef`; unquoted data is taken as is. */
    public static function txt(string $data): string
    {
        if (preg_match_all('/"((?:[^"\\\\]|\\\\.)*)"/', $data, $m) > 0) {
            return implode('', array_map(fn ($s) => stripcslashes($s), $m[1]));
        }

        return $data;
    }
}
