<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

/** Sends one signed webhook request. OutboundWebhookClient (real) or FakeWebhookClient (WEBHOOKS_OUT_FAKE). */
interface WebhookSender
{
    /** @param array<string, string> $headers */
    public function send(string $url, array $headers, string $body): SendResult;
}
