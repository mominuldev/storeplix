<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\Models\Plan;
use App\Domain\Sms\Models\SmsMessage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\FraudGuard\FraudGuardFixtures;
use Tests\TestCase;

/** PHASE-8-9A §4.3: the checkout code fails open only when allowance AND credits are gone; the code text is never stored. */
#[Group('sms')]
class SmsGuardAndPosSendersTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase, SmsChargingFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpGuard();
    }

    public function test_checkout_code_is_paid_with_credits_after_the_allowance_and_fails_open_without(): void
    {
        [, $tenant, $store] = $this->guardShop();
        $this->smsPlan($tenant, Plan::STARTER, 1, 1000);
        $this->usedSms($tenant, 1);

        $this->assertFalse($this->otp($store, '01766000111')->assertOk()->json('data.required'), 'no allowance, no credits → fail open');
        $this->assertSame(0, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'checkout_otp')->count());

        $this->giveCredits($tenant, 5);
        $this->assertTrue($this->otp($store, '01766000222')->assertOk()->json('data.required'));
        $row = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'checkout_otp')->sole();
        $this->assertSame(['credits', $store->id, null], [$row->charged_from, $row->store_id, $row->body_preview]);
        $this->assertSame(5 - $row->parts, $this->balance($tenant));
        $this->assertLedgerMatches($tenant);
    }
}
