<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

use Illuminate\Support\Facades\Cache;

/**
 * DOMAINS_FAKE (§5.3): answers from the cache under `fake-dns:{name}:{type}` (a list of values, or "servfail"),
 * written by `POST /dev/domains/{id}/dns` or tests. Nothing stored for any type → NXDOMAIN. An A/AAAA question also
 * returns the name's fake CNAME (the answer chain).
 */
final class FakeDnsResolver implements DnsResolver
{
    public const SERVFAIL = 'servfail';

    public function __construct(private readonly string $resolverName = 'fake', private readonly string $prefix = 'fake-dns') {}

    public function name(): string
    {
        return $this->resolverName;
    }

    public function query(string $name, string $type): DnsAnswer
    {
        $name = strtolower(rtrim($name, '.'));
        $values = Cache::get($this->key($name, $type));
        if ($values === self::SERVFAIL) {
            return DnsAnswer::error();
        }
        $records = [];
        if (in_array($type, ['A', 'AAAA'], true)) {
            foreach ((array) Cache::get($this->key($name, 'CNAME'), []) as $cname) {
                $records[] = ['type' => DnsAnswer::TYPES['CNAME'], 'data' => $cname.'.'];
            }
        }
        foreach ((array) ($values ?? []) as $value) {
            $records[] = ['type' => DnsAnswer::TYPES[$type], 'data' => $type === 'TXT' ? '"'.$value.'"' : $value];
        }
        if ($records === [] && ! $this->exists($name)) {
            return DnsAnswer::nxdomain();
        }

        return DnsAnswer::ok($records);
    }

    /** @param list<string>|string|null $values null = remove */
    public static function set(string $name, string $type, array|string|null $values, string $prefix = 'fake-dns'): void
    {
        $key = $prefix.':'.strtolower(rtrim($name, '.')).':'.$type;
        $values === null ? Cache::forget($key) : Cache::forever($key, $values);
    }

    private function key(string $name, string $type): string
    {
        return $this->prefix.':'.$name.':'.$type;
    }

    private function exists(string $name): bool
    {
        foreach (array_keys(DnsAnswer::TYPES) as $type) {
            if (Cache::has($this->key($name, $type))) {
                return true;
            }
        }

        return false;
    }
}
