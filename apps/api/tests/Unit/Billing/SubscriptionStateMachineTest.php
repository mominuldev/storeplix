<?php

declare(strict_types=1);

namespace Tests\Unit\Billing;

use App\Domain\Billing\Exceptions\InvalidSubscriptionTransition;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\SubscriptionStateMachine;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** PHASE-7 §3.1: the full transition matrix, including the illegal moves. */
#[Group('billing')]
class SubscriptionStateMachineTest extends TestCase
{
    public function test_matrix(): void
    {
        $allowed = [
            'trialing' => ['trialing', 'active'],
            'active' => ['active', 'past_due'],
            'past_due' => ['active', 'expired'],
            'expired' => [],
            'cancelled' => [],
        ];
        foreach (Subscription::STATUSES as $from) {
            foreach (Subscription::STATUSES as $to) {
                $this->assertSame(in_array($to, $allowed[$from], true), SubscriptionStateMachine::can($from, $to), "{$from} → {$to}");
            }
        }
    }

    public function test_illegal_move_throws_before_touching_the_database(): void
    {
        $this->expectException(InvalidSubscriptionTransition::class);
        SubscriptionStateMachine::move(new Subscription, Subscription::TRIALING, Subscription::PAST_DUE);
    }
}
