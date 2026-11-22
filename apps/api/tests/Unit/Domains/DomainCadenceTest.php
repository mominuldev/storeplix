<?php

declare(strict_types=1);

namespace Tests\Unit\Domains;

use App\Domain\Domains\DomainCadence;
use App\Domain\Domains\Providers\ProviderHostname;
use App\Domain\Stores\Models\StoreDomain;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** §2.2 cadence with a frozen clock + §5.2 provider status mapping (data-driven). */
#[Group('domains')]
class DomainCadenceTest extends TestCase
{
    private function row(string $status, array $attrs = []): StoreDomain
    {
        $row = new StoreDomain;
        $row->forceFill(['status' => $status, 'type' => 'custom'] + $attrs);

        return $row;
    }

    public function test_cadence(): void
    {
        $now = CarbonImmutable::parse('2026-11-22 10:00:00');
        $this->travelTo($now);
        $pending = $this->row('pending_verification', ['verification_started_at' => $now->subHour()]);
        $minutes = fn (?CarbonImmutable $at) => $at === null ? null : (int) round($now->diffInMinutes($at));
        $this->assertSame([1, 5, 15, 30, 30], array_map(fn ($n) => $minutes(DomainCadence::next($pending, $n, $now)), [1, 2, 3, 4, 50]));
        // capped at the 72 h deadline
        $late = $this->row('pending_verification', ['verification_started_at' => $now->subHours(72)->addMinutes(10)]);
        $this->assertSame(10, $minutes(DomainCadence::next($late, 9, $now)));

        $verified = $this->row('verified', ['verified_at' => $now, 'status_changed_at' => $now]);
        $this->assertSame([2, 5, 15, 30, 30], array_map(fn ($n) => $minutes(DomainCadence::next($verified, $n, $now)), [1, 2, 3, 4, 5]));

        $this->assertSame(2, $minutes(DomainCadence::next($this->row('ssl_provisioning', ['status_changed_at' => $now->subMinutes(59)]), 1, $now)));
        $this->assertSame(15, $minutes(DomainCadence::next($this->row('ssl_provisioning', ['status_changed_at' => $now->subMinutes(61)]), 1, $now)));

        $daily = $minutes(DomainCadence::next($this->row('active'), 1, $now));
        $this->assertGreaterThanOrEqual(23 * 60, $daily);
        $this->assertLessThanOrEqual(25 * 60, $daily);
        $this->assertSame(360, $minutes(DomainCadence::next($this->row('active', ['first_failed_at' => $now]), 1, $now)));
        foreach (['verification_failed', 'expired', 'suspended'] as $status) {
            $this->assertNull(DomainCadence::next($this->row($status), 1, $now));
            $this->assertNull(DomainCadence::afterTransition($status, $now));
        }
        $this->assertSame(0, $minutes(DomainCadence::afterTransition('pending_verification', $now)));
        $this->assertSame(2, $minutes(DomainCadence::afterTransition('ssl_provisioning', $now)));
    }

    /** @return list<array{0: string|null, 1: string, 2: string}> */
    public static function statuses(): array
    {
        $rows = [];
        foreach (['active' => 'active', 'pending' => 'pending', 'pending_validation' => 'pending', 'pending_ownership' => 'pending',
            'test_pending' => 'pending', 'active_redeploying' => 'pending', 'blocked' => 'blocked', 'pending_blocked' => 'blocked',
            'moved' => 'moved', 'deleted' => 'gone', 'pending_deletion' => 'gone', 'something_new' => 'pending'] as $raw => $state) {
            $rows["hostname {$raw}"] = ['hostname', $raw, $state];
        }
        foreach (['active' => 'active', 'initializing' => 'pending', 'pending_validation' => 'pending', 'pending_issuance' => 'pending',
            'pending_deployment' => 'pending', 'staging_deployment' => 'pending', 'holding_deployment' => 'pending', 'backup_issued' => 'pending',
            'validation_timed_out' => 'failed', 'issuance_timed_out' => 'failed', 'deployment_timed_out' => 'failed',
            'initializing_timed_out' => 'failed', 'expired' => 'failed', 'deleted' => 'failed', 'inactive' => 'failed',
            'deactivating' => 'failed', 'brand_new_state' => 'pending'] as $raw => $state) {
            $rows["ssl {$raw}"] = ['ssl', $raw, $state];
        }

        return $rows;
    }

    #[DataProvider('statuses')]
    public function test_provider_status_mapping(string $kind, string $raw, string $expected): void
    {
        $this->assertSame($expected, $kind === 'ssl' ? ProviderHostname::mapSsl($raw) : ProviderHostname::mapHostname($raw));
    }
}
