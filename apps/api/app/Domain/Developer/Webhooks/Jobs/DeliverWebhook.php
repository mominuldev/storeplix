<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Jobs;

use App\Domain\Developer\Webhooks\WebhookDeliveries;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * One attempt of one webhook delivery (PHASE-8-4 §4.3, S110), inside the delivery's tenant (TenantAware), on queue
 * `webhooks-out`. Unique per delivery id. The retry schedule lives on the row (next_attempt_at, P84-9) and the minute
 * sweep `webhooks:dispatch-due` re-dispatches due rows, so the queue itself never retries.
 */
class DeliverWebhook implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 30;

    public int $uniqueFor = 120;

    public function __construct(public readonly string $deliveryId)
    {
        $this->onQueue((string) config('webhooks_out.queue', 'webhooks-out'));
    }

    public function uniqueId(): string
    {
        return 'webhook-delivery:'.$this->deliveryId;
    }

    public function handle(WebhookDeliveries $deliveries): void
    {
        $deliveries->attempt($this->deliveryId);
    }
}
