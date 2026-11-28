<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\Models\Plan;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-8-9A S211 (Postgres race): 20 parallel charges against a balance for 10 → exactly 10 paid with credits, 10
 * skipped, balance 0 and the ledger sum equal to the balance change; the account row lock serialises the allowance
 * count too (one allowance slot is never used twice).
 */
#[Group('sms')]
#[Group('race')]
class SmsChargeRaceTest extends TestCase
{
    use CommerceFixtures, ForksRaces, RefreshDatabase, SmsChargingFixtures;

    public function test_parallel_charges_never_overspend_the_credits(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, $store] = $this->liveShop();
            $this->smsPlan($tenant, Plan::STARTER, 2, 1000);
            $this->usedSms($tenant, 1); // one allowance slot left
            $this->giveCredits($tenant, 10);
            $ids = $this->inTenant($tenant, fn () => array_map(fn () => SmsMessage::query()->create([
                'tenant_id' => $tenant->id, 'store_id' => $store->id, 'to' => '8801711000001', 'purpose' => 'order_confirmed',
                'template' => 'order_confirmed.en', 'status' => SmsMessage::QUEUED,
            ])->id, range(1, 21)));

            $results = $this->parallel(21, fn (int $i) => $this->inTenant($tenant, function () use ($ids, $i) {
                $charge = app(SmsCharger::class)->charge(SmsMessage::query()->findOrFail($ids[$i]), 'Shop: Order SH-1 is confirmed.');

                return match ($charge->from) {
                    SmsMessage::ALLOWANCE => 200,
                    SmsMessage::CREDITS => 201,
                    default => 402,
                };
            }));

            sort($results);
            $this->assertSame([...array_fill(0, 1, 200), ...array_fill(0, 10, 201), ...array_fill(0, 10, 402)], $results);
            $this->assertSame(0, $this->balance($tenant));
            $this->assertSame(10, SmsCreditLedgerEntry::withoutTenancy()->where('tenant_id', $tenant->id)->where('type', 'consume')->count());
            $this->assertLedgerMatches($tenant);
        } finally {
            $this->raceCleanup();
        }
    }
}
