<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\Models\Plan;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Pos\PosFixtures;
use Tests\TestCase;

/** PHASE-8-9A §4.3: the POS SMS receipt answers 402 only when neither the allowance nor the credits cover it. */
#[Group('sms')]
class SmsPosReceiptTest extends TestCase
{
    use PosFixtures, RefreshDatabase, SmsChargingFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_receipt_resend_uses_credits_and_402_only_without_them(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $this->smsPlan($tenant, Plan::GROWTH, 1, 5000);
        $session = $this->posSession($s);
        $sale = $this->cashSale($s, $session, 1, ['sms_receipt' => true, 'customer' => ['phone' => '01711552211', 'name' => 'Farhana']]);
        $this->assertSame('sent', $sale['sms_receipt_status']);

        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$sale['id']}/sms-receipt"))->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached');
        $this->giveCredits($tenant, 3);
        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$sale['id']}/sms-receipt"))->assertOk();
        $this->assertCount(2, app(SmsGateway::class)->sent);
        $paid = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('charged_from', 'credits')->sole();
        $this->assertSame(['pos_receipt', 'pos_sale', $sale['id']], [$paid->purpose, $paid->reference_type, $paid->reference_id]);
        $this->assertSame(3 - $paid->parts, $this->balance($tenant));
    }
}
