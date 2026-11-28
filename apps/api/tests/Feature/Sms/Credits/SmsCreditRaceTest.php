<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Credits;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-8-9A S212 race (Postgres + pcntl; skipped elsewhere): two concurrent server-side verifications of one SMS
 * credit payment (return + IPN / reconcile) grant the pack exactly once.
 */
#[Group('sms')]
#[Group('billing')]
class SmsCreditRaceTest extends TestCase
{
    use BillingFixtures, ForksRaces, RefreshDatabase, SmsCreditFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_verifications_of_one_payment_grant_the_credits_once(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, , $h] = $this->shop();
            $payment = (string) $this->buyPack($h, 'credits_1000')->assertCreated()->json('data.payment.id');
            $this->parallel(2, function () use ($tenant, $payment) {
                $this->inTenant($tenant, function () use ($payment) {
                    $row = BillingPayment::query()->findOrFail($payment);
                    app(BillingPaymentService::class)->confirm($row, new Verification(Verification::SUCCEEDED, $row->amount, 'BDT', $row->id, 'TRX-RACE', null, []));
                });

                return 200;
            });
            $this->assertSame(1000, $this->inTenant($tenant, fn () => (int) SmsCreditAccount::query()->value('balance')));
            $this->assertSame(1, $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->where('type', 'purchase')->count()));
        } finally {
            $this->raceCleanup();
        }
    }
}
