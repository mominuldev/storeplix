<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\FraudGuard\Models\CheckoutOtp;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8 §7 storefront rules: blocklist (S159), daily limit (P88-11), checkout OTP (P88-13, S160).
 */
#[Group('fraud')]
#[Group('security')]
class FraudGuardCheckoutTest extends TestCase
{
    use FraudGuardFixtures, RefreshDatabase;

    private const PHONE = '01766000111';

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpGuard(throttle: $this->name() === 'test_otp_route_limiters_answer_429');
    }

    public function test_blocked_number_cannot_use_cod_but_can_pay_online_in_every_phone_form(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false]);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '+8801766000111', 'note' => 'Fake orders'])->assertCreated();

        foreach (['01766000111', '+8801766000111', '8801766000111', '017-6600-0111'] as $form) {
            $this->sfCheckout($store, $variant, $form)->assertStatus(422)->assertJsonPath('error.code', 'cod_unavailable')
                ->assertJsonPath('error.message', "Cash on delivery isn't available for this number. Please pay online.");
        }
        $this->onlineCheckout($store, $variant, 'bkash', ['contact' => ['phone' => self::PHONE]])->assertCreated();
        $this->assertCount(4, $this->guardEvents($tenant, 'blocked_checkout'));
        $this->assertSame(4, $this->api($h, 'GET', $this->gUrl($store, '/overview'))->json('data.stopped.blocked'));
        $this->assertSame(1, $this->committed($tenant, $variant), 'refused COD checkouts reserve no stock (only the online order)');
    }

    public function test_daily_limit_refuses_the_next_cod_order_only_for_that_day(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop(settings: ['otp_enabled' => false, 'duplicates_enabled' => false, 'daily_limit' => 2]);
        $this->sfCheckout($store, $variant, self::PHONE)->assertCreated();
        $this->sfCheckout($store, $variant, self::PHONE)->assertCreated();
        $this->sfCheckout($store, $variant, self::PHONE)->assertStatus(422)->assertJsonPath('error.code', 'order_limit_reached')
            ->assertJsonPath('error.message', "You've reached today's order limit for cash on delivery. Please pay online or try tomorrow.");
        $this->onlineCheckout($store, $variant, 'bkash', ['contact' => ['phone' => self::PHONE]])->assertCreated();
        $this->sfCheckout($store, $variant, '01766000222')->assertCreated(); // another number
        $this->assertSame(0, $this->blockedRows($tenant), 'no permanent block (Q188)');
        $event = $this->api($h, 'GET', $this->gUrl($store, '/events?filter[type]=limit_reached'))->json('data.0.detail');
        $this->assertEquals(['count' => 2, 'limit' => 2], $event);

        $this->travel(1)->days();
        $this->sfCheckout($store, $variant, self::PHONE)->assertCreated();
    }

    public function test_new_number_needs_a_code_known_number_does_not(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop();
        $this->sfCheckout($store, $variant, self::PHONE)->assertStatus(422)->assertJsonPath('error.code', 'otp_required');

        $sent = $this->otp($store, self::PHONE, ['X-Cart-Token' => null])->assertOk()->assertHeader('Cache-Control', 'no-store, private')->json('data');
        $this->assertTrue($sent['required']);
        $this->assertSame(60, $sent['resend_after_seconds']);
        $this->assertNotNull($sent['expires_at']);
        $this->assertStringNotContainsString((string) $this->lastCode(self::PHONE), (string) json_encode($sent));
        $code = $this->lastCode(self::PHONE);
        $this->assertNotNull($code);
        $row = $this->inTenant($tenant, fn () => CheckoutOtp::query()->firstOrFail());
        $this->assertNotSame($code, $row->code_hash);
        $this->assertSame(64, strlen($row->code_hash));

        $wrong = $code === '000000' ? '111111' : '000000';
        $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => $wrong])->assertStatus(422)
            ->assertJsonPath('error.code', 'otp_invalid')->assertJsonPath('error.details.attempts_left', 4);
        $number = $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => $code])->assertCreated()->json('data.order.number');
        $this->assertNull($this->orderOf($tenant, $number)->guard_hold);

        // A number with a delivered order at this shop is known: no code.
        $this->history($tenant, $store, $h, $variant, '01766000333', 1, 0);
        $this->sfCheckout($store, $variant, '01766000333')->assertCreated();
        // Online payment never needs a code.
        $this->onlineCheckout($store, $variant, 'bkash', ['contact' => ['phone' => '01766000444']])->assertCreated();
    }

    public function test_otp_attempts_ttl_and_resend_limits(): void
    {
        [, , $store, , $variant] = $this->guardShop();
        $this->otp($store, self::PHONE)->assertOk();
        $this->otp($store, self::PHONE)->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $code = $this->lastCode(self::PHONE);
        $wrong = $code === '000000' ? '111111' : '000000';
        foreach ([4, 3, 2, 1, 0] as $left) {
            $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => $wrong])->assertStatus(422)->assertJsonPath('error.details.attempts_left', $left);
        }
        $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => $code])->assertStatus(422)->assertJsonPath('error.code', 'otp_invalid');

        $this->travel(61)->seconds();
        $this->otp($store, self::PHONE)->assertOk();
        $fresh = $this->lastCode(self::PHONE);
        $this->travel(301)->seconds();
        $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => $fresh])->assertStatus(422)->assertJsonPath('error.code', 'otp_invalid');
        $this->sfCheckout($store, $variant, self::PHONE, ['otp_code' => '12ab56'])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_otp_route_limiters_answer_429(): void
    {
        [, , $store] = $this->guardShop();
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.20'];
        for ($i = 0; $i < 5; $i++) {
            $this->travel(61)->seconds();
            $this->otp($store, self::PHONE, ['X-Storefront-Client-Ip' => '198.51.100.'.(30 + $i)])->assertOk();
        }
        $this->travel(61)->seconds();
        $this->otp($store, self::PHONE, $ip)->assertStatus(429); // 5 per phone per hour
        for ($i = 0; $i < 20; $i++) { // a refused request doesn't count: 20 sends from this IP
            $this->otp($store, '0176600'.str_pad((string) (1000 + $i), 4, '0', STR_PAD_LEFT), $ip)->assertOk();
        }
        $this->otp($store, '01766009999', $ip)->assertStatus(429); // 20 per IP per hour
    }

    public function test_otp_response_is_the_same_for_blocked_known_and_unknown_numbers(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop();
        $this->history($tenant, $store, $h, $variant, '01766000555', 3, 0);
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => '01766000666'])->assertCreated();
        $shapes = [];
        foreach (['01766000555', '01766000666', '01766000777'] as $phone) {
            $data = $this->otp($store, $phone)->assertOk()->json('data');
            $shapes[] = [$data['required'], $data['resend_after_seconds'], array_keys($data)];
        }
        $this->assertCount(1, array_unique(array_map('json_encode', $shapes)));

        // Rule off or guard off → required false (still no oracle).
        $this->guardSettings($h, $store, ['otp_enabled' => false])->assertOk();
        $this->assertSame(['required' => false, 'expires_at' => null, 'resend_after_seconds' => 0], $this->otp($store, '01766000888')->json('data'));
    }

    public function test_sms_failure_fails_open_and_the_order_is_held_for_a_call(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop();
        app(SmsGateway::class)->failNext = true;
        $this->otp($store, self::PHONE)->assertOk()->assertJsonPath('data.required', true);
        $this->assertNull($this->lastCode(self::PHONE));

        $number = $this->sfCheckout($store, $variant, self::PHONE)->assertCreated()->json('data.order.number');
        $guard = $this->api($h, 'GET', $this->oUrl($store, $this->orderOf($tenant, $number)->id))->json('data.guard');
        $this->assertSame('call_first', $guard['hold']);
        $this->assertContains('otp_unavailable', $guard['reasons']);
        $this->assertContains('otp_failed', $this->guardEvents($tenant));
    }

    public function test_exhausted_sms_allowance_fails_open_and_codes_count_against_it(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop();
        $before = $this->inTenant($tenant, fn () => FeatureGate::usage($tenant, Limit::SmsPerMonth));
        $this->otp($store, self::PHONE)->assertOk();
        $this->assertSame($before + 1, $this->inTenant($tenant, fn () => FeatureGate::usage($tenant, Limit::SmsPerMonth)));

        $limit = $this->inTenant($tenant, fn () => FeatureGate::limit($tenant, Limit::SmsPerMonth));
        $this->assertNotNull($limit);
        $this->inTenant($tenant, function () use ($tenant, $limit) {
            for ($i = FeatureGate::usage($tenant, Limit::SmsPerMonth); $i < $limit; $i++) {
                SmsMessage::query()->create(['tenant_id' => $tenant->id, 'to' => '8801700000000', 'purpose' => 'order_placed', 'template' => 'order_placed.bn', 'status' => 'sent']);
            }
        });
        $this->assertSame(['required' => false, 'expires_at' => null, 'resend_after_seconds' => 0], $this->otp($store, '01766000999')->json('data'));
        $number = $this->sfCheckout($store, $variant, '01766000999')->assertCreated()->json('data.order.number');
        $this->assertSame('call_first', $this->orderOf($tenant, $number)->guard_hold);
    }

    public function test_free_plan_has_no_checkout_rules(): void
    {
        [, $tenant, $store, $h, $variant] = $this->guardShop();
        $this->api($h, 'POST', $this->gUrl($store, '/blocked-numbers'), ['phone' => self::PHONE])->assertCreated();
        $this->planFor($tenant, 'free');
        $this->assertFalse($this->otp($store, self::PHONE)->json('data.required'));
        $this->sfCheckout($store, $variant, self::PHONE)->assertCreated();
    }
}
