<?php

declare(strict_types=1);

namespace Tests\Unit\Pos;

use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Pos\PosMoney;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8D §6, P88D-9, P88D-15 (S201): till money maths — integers only, change never a payment. */
#[Group('pos')]
class PosMoneyTest extends TestCase
{
    public function test_denomination_counts_add_up_in_minor_units(): void
    {
        $this->assertSame([100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100], PosMoney::denominations('BDT'));
        $this->assertSame([], PosMoney::denominations('USD'));
        $this->assertSame(100000 * 2 + 50000 + 500 * 3 + 100, PosMoney::countsTotal(['100000' => 2, '50000' => 1, '500' => 3, '100' => 1, '20000' => 0], 'BDT'));
        $this->assertSame(0, PosMoney::countsTotal([], 'BDT'));
        $this->assertSame(['100000' => 1, '500' => 2, '100' => 0], PosMoney::normaliseCounts([100 => 0, 500 => 2, 100000 => 1]));

        foreach ([['300' => 1], ['abc' => 1], ['100000' => -1], ['100000' => 10001], ['100000' => '2']] as $bad) {
            try {
                PosMoney::countsTotal($bad, 'BDT');
                $this->fail('accepted '.json_encode($bad));
            } catch (ValidationException $e) {
                $this->assertStringStartsWith('counts.', (string) array_key_first($e->errors()));
            }
        }
        $this->expectException(ValidationException::class);
        PosMoney::countsTotal(['100' => 1], 'USD'); // non-BDT: one amount field only
    }

    public function test_settle_cash_with_change_split_and_non_cash(): void
    {
        $this->assertSame(['cash_amount' => 90000, 'tendered_cash_amount' => 100000, 'change_amount' => 10000], PosMoney::settle(90000, [['method' => 'cash', 'amount' => 90000]], 100000));
        $this->assertSame(['cash_amount' => 90000, 'tendered_cash_amount' => 90000, 'change_amount' => 0], PosMoney::settle(90000, [['method' => 'cash', 'amount' => 90000]], 90000));
        $this->assertSame(['cash_amount' => 30000, 'tendered_cash_amount' => 50000, 'change_amount' => 20000],
            PosMoney::settle(100000, [['method' => 'cash', 'amount' => 30000], ['method' => 'bkash_personal', 'amount' => 70000]], 50000));
        $this->assertSame(['cash_amount' => 0, 'tendered_cash_amount' => null, 'change_amount' => 0],
            PosMoney::settle(100000, [['method' => 'card', 'amount' => 60000], ['method' => 'bkash_personal', 'amount' => 40000]], 999999));
    }

    public function test_settle_refuses_mismatch_short_cash_and_two_cash_parts(): void
    {
        $code = function (callable $fn): string {
            try {
                $fn();
            } catch (ApiException $e) {
                return $e->errorCode.':'.json_encode($e->details);
            } catch (ValidationException $e) {
                return 'validation_failed:'.implode(',', array_keys($e->errors()));
            }

            return 'ok';
        };
        $this->assertSame('pos_payment_mismatch:{"total_amount":100000,"paid_amount":99999}', $code(fn () => PosMoney::settle(100000, [['method' => 'card', 'amount' => 99999]], null)));
        $this->assertSame('pos_payment_mismatch:{"total_amount":100000,"paid_amount":100001}', $code(fn () => PosMoney::settle(100000, [['method' => 'cash', 'amount' => 100001]], 200000)));
        $this->assertStringStartsWith('cash_tendered_short:', $code(fn () => PosMoney::settle(100000, [['method' => 'cash', 'amount' => 100000]], 99999)));
        $this->assertStringStartsWith('cash_tendered_short:', $code(fn () => PosMoney::settle(100000, [['method' => 'cash', 'amount' => 100000]], null)));
        $this->assertSame('validation_failed:payments.1.method', $code(fn () => PosMoney::settle(100000, [['method' => 'cash', 'amount' => 50000], ['method' => 'cash', 'amount' => 50000]], 100000)));
    }

    public function test_expected_drawer_variance_tolerance_left_and_banked(): void
    {
        $this->assertSame(290000 - 45000, PosMoney::expectedCash(200000, 90000, 45000));
        $this->assertSame(['variance_amount' => -2000, 'banked_amount' => 188000], PosMoney::close(288000, 290000, 100000, null, 5000));
        $this->assertSame(['variance_amount' => 5000, 'banked_amount' => 295000], PosMoney::close(295000, 290000, 0, null, 5000)); // exactly the tolerance: no note
        $this->assertSame(['variance_amount' => -20000, 'banked_amount' => 270000], PosMoney::close(270000, 290000, 0, 'Paid the tea boy', 5000));
        $this->assertSame(['variance_amount' => 0, 'banked_amount' => 0], PosMoney::close(5000, 5000, 5000, null, 5000)); // left = counted

        try {
            PosMoney::close(270000, 290000, 0, '   ', 5000);
            $this->fail('closed over tolerance without a note');
        } catch (ApiException $e) {
            $this->assertSame(['close_note_required', ['variance_amount' => -20000, 'tolerance_amount' => 5000]], [$e->errorCode, $e->details]);
        }
        $this->expectException(ValidationException::class);
        PosMoney::close(10000, 10000, 10001, null, 5000);
    }

    public function test_included_vat_floors(): void
    {
        $this->assertSame(15000, PosMoney::includedVat(115000, 1500));
        $this->assertSame(1304, PosMoney::includedVat(10000, 1500)); // floor(1304.34…)
        $this->assertSame(0, PosMoney::includedVat(10000, 0));
        $this->assertSame(0, PosMoney::includedVat(0, 1500));
    }

    public function test_pos_receipt_sms_fits_three_segments_footer_cut_first_no_links(): void
    {
        foreach (['bn', 'en'] as $language) {
            $vars = ['shop' => str_repeat('S', 40), 'number' => 'ABCDEF-1234567', 'total' => '1,000,000', 'method' => 'Cash + bKash + Card',
                'footer' => str_repeat('F', 120)];
            $text = SmsTemplates::render(SmsTemplates::POS_RECEIPT, $language, $vars);
            $this->assertLessThanOrEqual(SmsTemplates::MAX_CHARS, mb_strlen($text), $language);
            $this->assertStringContainsString(str_repeat('S', 40), $text); // the footer went first
            $this->assertStringContainsString('ABCDEF-1234567', $text);
            $this->assertStringNotContainsString('{', $text);
            $short = SmsTemplates::render(SmsTemplates::POS_RECEIPT, $language, ['footer' => 'Come again!'] + $vars);
            $this->assertStringContainsString('Come again!', $short);
        }
        $this->assertSame('Thanks for shopping', SmsTemplates::clean("Thanks\n https://evil.example/x for shopping", 120)); // S13 footer sanitising
        $this->assertContains(SmsTemplates::POS_RECEIPT, SmsTemplates::COUNTED);
        $this->assertNotContains(SmsTemplates::POS_RECEIPT, SmsTemplates::EVENTS); // never an order-status toggle
    }
}
