<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/** The system resolver: every A and AAAA record (all of them are checked, P84 §4.3). */
final class SystemHostResolver implements HostResolver
{
    public function resolve(string $host): array
    {
        $ips = [];
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        foreach (is_array($records) ? $records : [] as $record) {
            $ip = $record['ip'] ?? $record['ipv6'] ?? null;
            if (is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP) !== false) {
                $ips[] = $ip;
            }
        }
        if ($ips === []) {
            $v4 = @gethostbynamel($host);
            $ips = is_array($v4) ? $v4 : [];
        }

        return array_values(array_unique($ips));
    }
}
