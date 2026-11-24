<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/** A checked endpoint URL: host, port and the public IPs it resolved to (empty when DNS was skipped). */
final readonly class WebhookTarget
{
    /** @param list<string> $ips */
    public function __construct(
        public string $url,
        public string $scheme,
        public string $host,
        public int $port,
        public array $ips,
    ) {}
}
