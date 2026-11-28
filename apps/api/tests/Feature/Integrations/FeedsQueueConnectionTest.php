<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Feeds\Jobs\SyncCatalog;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** QA P89D-QA-A4: a feed sync must never be handed to a second worker while it is still running. */
#[Group('feeds')]
class FeedsQueueConnectionTest extends TestCase
{
    public function test_the_feeds_connection_reserves_a_job_longer_than_a_sync_may_run(): void
    {
        $job = new SyncCatalog('01JTESTINTEGRATION000000000', 'full', 'schedule');

        $this->assertSame('redis', config('queue.connections.redis-feeds.driver'));
        $this->assertGreaterThan($job->timeout, (int) config('queue.connections.redis-feeds.retry_after'));
    }

    public function test_sync_catalog_uses_the_configured_connection_and_the_default_otherwise(): void
    {
        config(['feeds.connection' => null]);
        $this->assertNull((new SyncCatalog('01JTESTINTEGRATION000000000', 'full', 'schedule'))->connection);

        config(['feeds.connection' => 'redis-feeds']);
        $job = new SyncCatalog('01JTESTINTEGRATION000000000', 'delta', 'product_change');
        $this->assertSame('redis-feeds', $job->connection);
        $this->assertSame('feeds', $job->queue);
    }
}
