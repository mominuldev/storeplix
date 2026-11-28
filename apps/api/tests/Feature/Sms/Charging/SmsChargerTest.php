<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\Plan;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsPurposes;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9A §4.2, §4.5 (P89A-3 – P89A-6, S211): allowance first, then credits (1 per part), else skipped; 0 allowance
 * never uses credits; unlimited never touches them; consume and refund at most once per SMS; usage excludes
 * credit-paid and skipped rows.
 */
#[Group('sms')]
#[Group('security')]
class SmsChargerTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsChargingFixtures;

    private const SHORT = 'Shop: Order SH-1 is confirmed.'; // 1 GSM-7 part

    private function message(Tenant $tenant, Store $store, string $purpose = 'order_confirmed'): SmsMessage
    {
        return $this->inTenant($tenant, fn () => SmsMessage::query()->create([
            'tenant_id' => $tenant->id, 'store_id' => $store->id, 'to' => '8801711000001', 'purpose' => $purpose,
            'template' => $purpose.'.en', 'status' => SmsMessage::QUEUED,
        ]));
    }

    private function charge(Tenant $tenant, SmsMessage $message, string $text, int $self = 0)
    {
        return $this->inTenant($tenant, fn () => app(SmsCharger::class)->charge($message, $text, $self));
    }

    public function test_transactional_allowance_then_credits_then_skipped(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->smsPlan($tenant, Plan::STARTER, 1, 1000);
        $this->giveCredits($tenant, 3);

        $first = $this->charge($tenant, $this->message($tenant, $store), self::SHORT);
        $this->assertSame([SmsMessage::ALLOWANCE, 1, 0], [$first->from, $first->parts, $first->credits]);
        $this->assertSame(3, $this->balance($tenant));

        $second = $this->charge($tenant, $m2 = $this->message($tenant, $store), self::SHORT);
        $this->assertSame([SmsMessage::CREDITS, 1, 1], [$second->from, $second->parts, $second->credits]);
        $this->assertSame(2, $this->balance($tenant));

        $long = str_repeat('Long text ', 20); // 200 GSM-7 chars → 2 parts, 2 credits
        $third = $this->charge($tenant, $this->message($tenant, $store), $long);
        $this->assertSame([SmsMessage::CREDITS, 2, 2], [$third->from, $third->parts, $third->credits]);
        $this->assertSame(0, $this->balance($tenant));

        $fourth = $this->charge($tenant, $m4 = $this->message($tenant, $store), self::SHORT);
        $this->assertTrue($fourth->skipped());
        $row = $this->platformQuery(SmsMessage::class)->findOrFail($m4->id);
        $this->assertSame(['skipped', 'no_credits', null, 0], [$row->status, $row->error_code, $row->charged_from, $row->credits_charged]);
        $this->assertSame(SmsPurposes::TRANSACTIONAL, $row->kind);

        // Usage counts only allowance-paid queued|sent rows (§4.5).
        $this->assertSame(1, $this->inTenant($tenant, fn () => FeatureGate::usage($tenant, Limit::SmsPerMonth)));
        $paid = $this->platformQuery(SmsMessage::class)->findOrFail($m2->id);
        $this->assertSame(['credits', 1, 1], [$paid->charged_from, $paid->credits_charged, $paid->parts]);
        $this->assertSame('Shop: Order SH-1 is confirmed.', $paid->body_preview);
        $this->assertLedgerMatches($tenant);
        $this->assertSame(2, $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->where('type', 'consume')->count()));
    }

    public function test_unlimited_never_touches_credits_and_zero_allowance_never_uses_them(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->smsPlan($tenant, Plan::GROWTH, null, 0);
        $this->giveCredits($tenant, 10);

        $this->assertSame(SmsMessage::ALLOWANCE, $this->charge($tenant, $this->message($tenant, $store), self::SHORT)->from);
        $this->assertSame(10, $this->balance($tenant));

        $marketing = $this->charge($tenant, $m = $this->message($tenant, $store, 'campaign'), self::SHORT);
        $this->assertTrue($marketing->skipped(), 'a 0 campaign allowance is never bypassed with credits (P89A-6)');
        $this->assertSame(10, $this->balance($tenant));
        $this->assertSame('marketing', $this->platformQuery(SmsMessage::class)->findOrFail($m->id)->kind);
        $this->assertFalse($this->inTenant($tenant, fn () => app(SmsCharger::class)->canAfford(SmsPurposes::MARKETING, 1)));
        $this->assertTrue($this->inTenant($tenant, fn () => app(SmsCharger::class)->canAfford(SmsPurposes::TRANSACTIONAL, 1)));
    }

    public function test_marketing_counts_parts_and_excludes_credit_paid_rows_from_the_allowance(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->smsPlan($tenant, Plan::STARTER, 2000, 3);
        $this->giveCredits($tenant, 5);
        $long = str_repeat('Eid offer! ', 18); // 198 chars → 2 parts

        $first = $this->charge($tenant, $this->message($tenant, $store, 'campaign'), $long);
        $this->assertSame([SmsMessage::ALLOWANCE, 2], [$first->from, $first->parts]);
        // A test send counted through its audit row (2 parts) → 2 used of 3; the next 2 parts go to credits.
        $this->inTenant($tenant, fn () => AuditLog::query()->create(['tenant_id' => $tenant->id, 'actor_type' => 'system', 'action' => 'campaign.test_sent',
            'meta' => ['channel' => 'sms', 'parts' => 2, 'charged_from' => 'allowance']]));
        $second = $this->charge($tenant, $this->message($tenant, $store, 'campaign'), $long);
        $this->assertSame([SmsMessage::CREDITS, 2, 2], [$second->from, $second->parts, $second->credits]);
        $this->assertSame(3, $this->balance($tenant));
        // `$selfUnits`: a claimed recipient's own parts already in the usage are not counted twice.
        $this->inTenant($tenant, fn () => AuditLog::query()->create(['tenant_id' => $tenant->id, 'actor_type' => 'system', 'action' => 'campaign.test_sent',
            'meta' => ['channel' => 'sms', 'parts' => 1, 'charged_from' => 'credits']]));
        $this->assertSame(2, $this->inTenant($tenant, fn () => CampaignAllowance::used('sms')), 'credit-paid test sends never count');
        $third = $this->charge($tenant, $this->message($tenant, $store, 'campaign'), 'Hi', 2);
        $this->assertSame(SmsMessage::ALLOWANCE, $third->from);
        $this->assertLedgerMatches($tenant);
    }

    public function test_consume_and_refund_happen_at_most_once_per_sms(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->smsPlan($tenant, Plan::STARTER, 0 + 1, 1000);
        $this->usedSms($tenant, 1);
        $this->giveCredits($tenant, 4);
        $message = $this->message($tenant, $store);

        $this->charge($tenant, $message, self::SHORT);
        $again = $this->charge($tenant, $message, self::SHORT); // a replayed job
        $this->assertSame([SmsMessage::CREDITS, 1], [$again->from, $again->credits]);
        $this->assertSame(3, $this->balance($tenant));

        $row = $this->platformQuery(SmsMessage::class)->findOrFail($message->id);
        $this->inTenant($tenant, function () use ($row) {
            $row->markFailed('provider said no');
            app(SmsCharger::class)->refund($row);
            app(SmsCharger::class)->refund($row);
        });
        $this->assertSame(4, $this->balance($tenant));
        $this->inTenant($tenant, function () use ($message) {
            $this->assertSame(1, SmsCreditLedgerEntry::query()->where('sms_message_id', $message->id)->where('type', 'consume')->count());
            $this->assertSame(1, SmsCreditLedgerEntry::query()->where('sms_message_id', $message->id)->where('type', 'refund')->count());
        });
        $failed = $this->platformQuery(SmsMessage::class)->findOrFail($message->id);
        $this->assertSame(['failed', 'provider_error'], [$failed->status, $failed->error_code]);
        $this->assertLedgerMatches($tenant);
    }

    public function test_shortfall_details_and_no_preview_for_codes(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $this->smsPlan($tenant, Plan::STARTER, 1, 1000);
        $this->usedSms($tenant, 1);
        $this->assertSame(['allowance_remaining' => 0, 'credits' => 0, 'needed' => 2],
            $this->inTenant($tenant, fn () => app(SmsCharger::class)->shortfall(SmsPurposes::TRANSACTIONAL, 2)));
        $this->giveCredits($tenant, 1);
        $code = $this->charge($tenant, $m = $this->message($tenant, $store, 'checkout_otp'), 'Shop: Your checkout code is 123456.');
        $this->assertSame(SmsMessage::CREDITS, $code->from);
        $this->assertNull($this->platformQuery(SmsMessage::class)->findOrFail($m->id)->body_preview, 'checkout codes are never stored (S217)');
    }
}
