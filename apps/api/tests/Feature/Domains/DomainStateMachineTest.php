<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Domains\DomainStateMachine;
use App\Domain\Domains\Events\DomainStatusChanged;
use App\Domain\Domains\InvalidDomainTransition;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\DomainFixtures;
use Tests\TestCase;

/** §2.1 / P6-10: the full transition matrix, platform refusal, and the conditional update race. */
#[Group('domains')]
class DomainStateMachineTest extends TestCase
{
    use DomainFixtures, RefreshDatabase;

    public function test_full_matrix(): void
    {
        Event::fake([DomainStatusChanged::class]);
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $machine = app(DomainStateMachine::class);
        $allowed = 0;
        foreach (StoreDomain::STATUSES as $from) {
            foreach (StoreDomain::STATUSES as $to) {
                $this->inTenant($tenant, fn () => StoreDomain::query()->whereKey($id)->update(['status' => $from, 'is_primary' => false]));
                $row = $this->domainRow($tenant, $id);
                $expected = in_array($to, DomainStateMachine::TRANSITIONS[$from], true);
                $this->assertSame($expected, DomainStateMachine::allowed($from, $to), "{$from} → {$to}");
                try {
                    $moved = $this->inTenant($tenant, fn () => $machine->transition($row, $to));
                    $this->assertTrue($expected, "{$from} → {$to} should be refused");
                    $this->assertSame($to, $moved?->status);
                    $allowed++;
                } catch (InvalidDomainTransition $e) {
                    $this->assertFalse($expected, "{$from} → {$to} should be allowed");
                    $this->assertSame([409, 'invalid_state_transition'], [$e->getStatusCode(), $e->errorCode]);
                }
            }
        }
        $this->assertSame(18, $allowed);
        Event::assertDispatched(DomainStatusChanged::class, 18);
        $this->assertSame(18, $this->platformQuery(AuditLog::class)->where('action', 'domain.status_changed')->count());
        // examples the contract calls out
        $this->assertFalse(DomainStateMachine::allowed('pending_verification', 'active'));
        $this->assertFalse(DomainStateMachine::allowed('active', 'pending_verification'));
    }

    public function test_platform_rows_never_enter_the_state_machine(): void
    {
        [, $tenant, $store] = $this->domainShop();
        $platform = $this->inTenant($tenant, fn () => StoreDomain::query()->where('store_id', $store->id)->firstOrFail());
        $this->expectException(InvalidDomainTransition::class);
        $this->inTenant($tenant, fn () => app(DomainStateMachine::class)->transition($platform, 'suspended'));
    }

    public function test_conditional_update_lets_only_one_of_two_transitions_win(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $first = $this->domainRow($tenant, $id);
        $second = $this->domainRow($tenant, $id); // both loaded while pending_verification
        $machine = app(DomainStateMachine::class);
        $a = $this->inTenant($tenant, fn () => $machine->transition($first, 'verified'));
        $b = $this->inTenant($tenant, fn () => $machine->transition($second, 'verification_failed'));
        $this->assertSame('verified', $a?->status);
        $this->assertNull($b, 'the stale transition matched no row');
        $this->assertSame('verified', $this->domainRow($tenant, $id)->status);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'domain.status_changed')->count());
    }
}
