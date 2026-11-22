<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

/** One DNS source (a DoH endpoint or the fake). The merchant's host is only ever a query parameter (S43). */
interface DnsResolver
{
    public function name(): string;

    /** @param 'A'|'AAAA'|'CNAME'|'TXT' $type */
    public function query(string $name, string $type): DnsAnswer;
}
