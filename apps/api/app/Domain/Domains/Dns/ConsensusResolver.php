<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\Http;
use InvalidArgumentException;

/**
 * P6-2 / P6-3: asks every configured resolver (concurrently for DoH) and decides per record. Both agree on a match →
 * ok; both say no record → missing; any other combination of answers → mismatch; any resolver error → the whole
 * check is inconclusive (no state change).
 */
final class ConsensusResolver
{
    public const MAX_FOUND = 5;

    /** @var array<string, DnsResolver> */
    private array $resolvers = [];

    /** @param list<DnsResolver> $resolvers */
    public function __construct(array $resolvers)
    {
        foreach ($resolvers as $resolver) {
            $this->resolvers[$resolver->name()] = $resolver;
        }
        if ($this->resolvers === []) {
            throw new InvalidArgumentException('At least one DNS resolver is required.');
        }
    }

    /** @return list<string> */
    public function names(): array
    {
        return array_keys($this->resolvers);
    }

    /** @return array<string, DnsAnswer> resolver name → answer */
    public function queryAll(string $name, string $type): array
    {
        $doh = array_filter($this->resolvers, fn ($r) => $r instanceof DohResolver);
        if (count($doh) > 1 && count($doh) === count($this->resolvers)) {
            /** @var array<string, DohResolver> $doh */
            $responses = Http::pool(function (Pool $pool) use ($doh, $name, $type) {
                $out = [];
                foreach ($doh as $key => $resolver) {
                    $out[] = $resolver->send($pool->as($key), $name, $type);
                }

                return $out;
            });
            $answers = [];
            foreach ($doh as $key => $resolver) {
                $answers[$key] = $resolver->parse($responses[$key] ?? null);
            }

            return $answers;
        }

        return array_map(fn (DnsResolver $r) => $r->query($name, $type), $this->resolvers);
    }

    /** TXT `{txtName}` must contain $expectedTxt; `{host}` must route to $target (CNAME chain or flattened apex). */
    public function verify(string $host, string $txtName, string $expectedTxt, string $target): DnsCheckResult
    {
        $memo = [];
        $errors = array_fill_keys($this->names(), false);
        $ask = function (string $resolver, string $name, string $type) use (&$memo, &$errors): DnsAnswer {
            $key = $name.'|'.$type;
            $memo[$key] ??= $this->queryAll($name, $type);
            $answer = $memo[$key][$resolver];
            if ($answer->isError()) {
                $errors[$resolver] = true;
            }

            return $answer;
        };

        $ownership = [];
        $routing = [];
        foreach ($this->names() as $resolver) {
            $ownership[$resolver] = $this->ownership(fn ($n, $t) => $ask($resolver, $n, $t), $txtName, $expectedTxt);
            $routing[$resolver] = $this->routing(fn ($n, $t) => $ask($resolver, $n, $t), $host, $target);
        }

        $own = self::combine($ownership);
        $route = self::combine($routing);
        $outcome = match (true) {
            $own['status'] === 'pending' || $route['status'] === 'pending' => DnsCheckResult::INCONCLUSIVE,
            $own['status'] === 'ok' && $route['status'] === 'ok' => DnsCheckResult::OK,
            default => DnsCheckResult::FAIL,
        };

        return new DnsCheckResult(
            $outcome,
            ['status' => $own['status'], 'found' => $own['found']],
            ['status' => $route['status'], 'found' => $route['found'], 'mode' => $route['mode']],
            array_map(fn (bool $e) => $e ? 'error' : 'ok', $errors),
        );
    }

    /**
     * @param  callable(string, string): DnsAnswer  $ask
     * @return array{status: string, found: list<string>, mode: string}
     */
    private function ownership(callable $ask, string $txtName, string $expected): array
    {
        $answer = $ask($txtName, 'TXT');
        if ($answer->isError()) {
            return ['status' => 'error', 'found' => [], 'mode' => 'txt'];
        }
        $values = $answer->values('TXT');
        $status = match (true) {
            in_array($expected, $values, true) => 'ok',
            $values === [] => 'missing',
            default => 'mismatch',
        };

        return ['status' => $status, 'found' => $status === 'ok' ? [$expected] : $values, 'mode' => 'txt'];
    }

    /**
     * @param  callable(string, string): DnsAnswer  $ask
     * @return array{status: string, found: list<string>, mode: string}
     */
    private function routing(callable $ask, string $host, string $target): array
    {
        $error = ['status' => 'error', 'found' => [], 'mode' => 'cname'];
        $cname = $ask($host, 'CNAME');
        if ($cname->isError()) {
            return $error;
        }
        $cnames = $cname->values('CNAME');
        if (in_array($target, $cnames, true)) {
            return ['status' => 'ok', 'found' => [$target], 'mode' => 'cname'];
        }

        // The A answer carries the whole CNAME chain (host → x → target).
        $hostA = $ask($host, 'A');
        if ($hostA->isError()) {
            return $error;
        }
        $chain = $hostA->values('CNAME');
        if (in_array($target, $chain, true)) {
            return ['status' => 'ok', 'found' => [$target], 'mode' => 'cname'];
        }
        if ($cnames !== [] || $chain !== []) {
            return ['status' => 'mismatch', 'found' => array_values(array_unique([...$cnames, ...$chain])), 'mode' => 'cname'];
        }

        // Apex / flattened (P6-3): the host's A set non-empty and ⊆ the target's, AAAA ⊆ the target's AAAA.
        $hostAaaa = $ask($host, 'AAAA');
        if ($hostAaaa->isError()) {
            return $error;
        }
        $a = $hostA->values('A');
        $aaaa = $hostAaaa->values('AAAA');
        if ($a === [] && $aaaa === []) {
            return ['status' => 'missing', 'found' => [], 'mode' => 'cname'];
        }
        $targetA = $ask($target, 'A');
        $targetAaaa = $ask($target, 'AAAA');
        if ($targetA->isError() || $targetAaaa->isError()) {
            return ['status' => 'error', 'found' => [], 'mode' => 'flattened'];
        }
        $ok = $a !== [] && array_diff($a, $targetA->values('A')) === [] && array_diff($aaaa, $targetAaaa->values('AAAA')) === [];

        return ['status' => $ok ? 'ok' : 'mismatch', 'found' => array_values([...$a, ...$aaaa]), 'mode' => 'flattened'];
    }

    /**
     * @param  array<string, array{status: string, found: list<string>, mode: string}>  $perResolver
     * @return array{status: string, found: list<string>, mode: string}
     */
    private static function combine(array $perResolver): array
    {
        $statuses = array_unique(array_column($perResolver, 'status'));
        $found = [];
        foreach ($perResolver as $result) {
            foreach ($result['found'] as $value) {
                $found[] = mb_substr($value, 0, 255);
            }
        }
        $found = array_slice(array_values(array_unique($found)), 0, self::MAX_FOUND);
        $first = reset($perResolver);
        $status = match (true) {
            in_array('error', $statuses, true) => 'pending',
            $statuses === ['ok'] => 'ok',
            $statuses === ['missing'] => 'missing',
            default => 'mismatch',
        };

        return ['status' => $status, 'found' => $status === 'missing' ? [] : $found, 'mode' => $first === false ? 'cname' : $first['mode']];
    }
}
