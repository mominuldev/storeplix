<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Support\Money;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Platform\PlatformSmsNotifier;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\SmsGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\BillingFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9B §5 senders: account codes unchanged (rows `tenant_id` NULL + `merchant_tenant_id`), welcome once after the
 * first phone verification, every billing event → SMS next to the email (shop language, owner's verified phone), switch
 * off → email only, unverified → none, admin "Resend invoice" → no SMS, billing keeps working when SMS throws.
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('billing')]
class PlatformSmsSendersTest extends TestCase
{
    use BillingFixtures, PlatformSmsFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
        Mail::fake();
        $this->freezeSecond();
    }

    /** @return list<SmsMessage> platform rows of a type */
    private function rows(PlatformSmsType $type): array
    {
        return $this->platformQuery(SmsMessage::class)->where('platform_type', $type->value)->orderBy('created_at')->get()->all();
    }

    public function test_codes_keep_their_text_and_become_platform_rows(): void
    {
        [$user] = $this->merchant();
        $user->forceFill(['phone' => '8801711552211', 'phone_verified_at' => now()])->save();
        $this->postJson('/api/v1/auth/otp/send', ['phone' => '01711552211', 'purpose' => 'login'])->assertStatus(202);
        $sent = $this->fake()->sent;
        $this->assertMatchesRegularExpression('/^Your Store Plix code is \d{6}\. Valid for 5 minutes\. Do not share it\.$/', end($sent)['text']);
        $this->assertSame('security', end($this->fake()->routes));
        $row = $this->platformQuery(SmsMessage::class)->where('purpose', 'otp_login')->sole();
        $this->assertNull($row->tenant_id);
        $this->assertSame('sign_in_code', $row->platform_type);
        $this->assertSame('sent', $row->status);
        $this->assertNull($row->body_preview);
    }

    public function test_welcome_is_sent_once_after_the_first_phone_verification(): void
    {
        [$user, $tenant, $store] = $this->owner('mugdho', verified: false);
        $h = ['X-Testing-User' => $user->id];
        $verify = function (string $phone) use ($h) {
            $r = $this->withHeaders($h)->postJson('/api/v1/auth/otp/send', ['phone' => $phone, 'purpose' => 'verify_phone']);
            $this->assertSame(202, $r->status(), $r->getContent());
            $code = $this->fake()->lastCodeFor((string) Phone::bdMsisdn($phone));
            $this->withHeaders($h)->postJson('/api/v1/auth/phone/verify', ['code' => $code])->assertOk();
        };
        $verify('0'.substr((string) $user->phone, 3));
        $welcome = $this->rows(PlatformSmsType::Welcome);
        $this->assertCount(1, $welcome);
        $this->assertNull($welcome[0]->tenant_id);
        $this->assertSame($tenant->id, $welcome[0]->merchant_tenant_id);
        $this->assertSame('sent', $welcome[0]->status);
        $sent = $this->fake()->sent;
        $this->assertSame("Store Plix-এ স্বাগতম, Mugdho Owner! {$store->name} তৈরি। পণ্য যোগ করে বিক্রি শুরু করুন: http://localhost:5183/settings/plan", end($sent)['text']);
        $this->assertSame('registration', end($this->fake()->routes));
        $this->assertSame('Store Plix-এ স্বাগতম, Mugdho Owner! '.$store->name.' তৈরি। পণ্য যোগ করে বিক্রি শুরু করুন: [link]', $welcome[0]->body_preview);

        // A second verification (another number) never sends it again.
        $user->refresh()->forceFill(['phone_verified_at' => null])->save();
        $verify('01999888777');
        $this->assertCount(1, $this->rows(PlatformSmsType::Welcome));
    }

    public function test_billing_events_send_sms_next_to_the_email(): void
    {
        [$owner, $tenant] = $this->owner('alpha', 'starter', language: 'en');
        $sub = $this->onPaidPlan($tenant, 'starter');
        $end = $sub->current_period_end->copy();

        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::INVOICE_ISSUED);
        $issued = $this->rows(PlatformSmsType::InvoiceIssued);
        $this->assertCount(1, $issued);
        $invoice = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole());
        $amount = Money::plain($invoice->total_amount);
        $this->assertSame("Store Plix: Invoice {$invoice->number} for Tk {$amount} (Starter) is due ".$end->copy()->timezone('Asia/Dhaka')->format('j M Y')
            .'. Pay: http://localhost:5183/settings/plan', collect($this->fake()->sent)->last()['text']);
        $this->assertSame('billing', collect($this->fake()->routes)->last());
        $this->assertSame($owner->phone, $issued[0]->to);

        $this->travelTo($end->copy()->subDays(3));
        $this->runBilling($tenant);
        $this->assertCount(1, $this->rows(PlatformSmsType::PaymentDue));

        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant); // the T-1 reminder catches up, then past due — one SMS next to each email
        $this->assertCount(3, $this->rows(PlatformSmsType::PaymentDue));
        $this->travelTo($end->copy()->addDays(6));
        $this->runBilling($tenant); // grace ending
        $this->assertCount(1, $this->rows(PlatformSmsType::PlanExpiring));
    }

    public function test_payment_received_trial_ending_switch_off_and_unverified(): void
    {
        [$owner, $tenant] = $this->owner('beta', 'free');
        $h = $this->tenantHeaders($owner, $tenant);
        $invoice = $this->changePlan($h, 'starter')->assertCreated()->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice)->assertCreated()->json('data.id');
        $this->fakeOutcome($tenant, $payment);
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::PAYMENT_RECEIVED);
        $received = $this->rows(PlatformSmsType::PaymentReceived);
        $this->assertCount(1, $received);
        $this->assertStringStartsWith('Store Plix: ইনভয়েস SP-', collect($this->fake()->sent)->last()['text']); // bn shop

        // The switch off → email only.
        $this->admin('PATCH', 'message-types/plan_expiring', ['enabled' => false])->assertOk()->assertJsonPath('data.enabled', false);
        [$trialOwner, $trialTenant] = $this->owner('gamma', 'growth', 'trialing', trialEnds: now()->addDays(2));
        $this->runBilling($trialTenant);
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::TRIAL_ENDING);
        $this->assertCount(0, $this->rows(PlatformSmsType::PlanExpiring));
        $this->admin('PATCH', 'message-types/plan_expiring', ['enabled' => true])->assertOk();

        // Unverified owner phone → no row at all.
        [, $unverified] = $this->owner('delta', 'growth', 'trialing', verified: false, trialEnds: now()->addDays(2));
        $this->runBilling($unverified);
        $this->assertCount(0, $this->rows(PlatformSmsType::PlanExpiring));
        [, $verified] = $this->owner('epsilon', 'growth', 'trialing', trialEnds: now()->addDays(2));
        $this->runBilling($verified);
        $this->assertCount(1, $this->rows(PlatformSmsType::PlanExpiring));
        $this->assertSame($verified->id, $this->rows(PlatformSmsType::PlanExpiring)[0]->merchant_tenant_id);

        // Admin "Resend invoice" sends the email again, never an SMS.
        $count = $this->platformTable('sms_messages')->count();
        $this->asAdminSurface()->flushHeaders()->withHeaders($this->adminHeaders($this->super()))
            ->postJson("/api/v1/admin/invoices/{$invoice}/resend")->assertStatus(202);
        $this->assertSame($count, $this->platformTable('sms_messages')->count());
    }

    public function test_billing_succeeds_when_the_sms_notifier_throws(): void
    {
        $this->app->instance(PlatformSmsNotifier::class, new class extends PlatformSmsNotifier
        {
            public function __construct() {}

            public function send(PlatformSmsType $type, User $to, array $vars, ?string $aboutTenantId = null, ?string $language = null): ?SmsMessage
            {
                throw new RuntimeException('SMS exploded');
            }
        });
        [, $tenant] = $this->owner('zeta', 'starter');
        $sub = $this->onPaidPlan($tenant, 'starter');
        $this->travelTo($sub->current_period_end->copy()->subDays(7));
        $this->runBilling($tenant);
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::INVOICE_ISSUED);
        $this->assertSame(1, $this->inTenant($tenant, fn () => BillingInvoice::query()->count()));
    }

    public function test_fake_gateway_failure_is_retried_within_the_window(): void
    {
        [$owner, $tenant] = $this->owner('eta');
        $this->fake()->failNextReason = 'unavailable';
        $row = app(PlatformSmsNotifier::class)->send(PlatformSmsType::PaymentReceived, $owner, ['invoice_no' => 'SP-9', 'amount' => '10', 'plan' => 'Growth'], $tenant->id);
        $this->assertSame('sent', $row->refresh()->status); // sync queue: the delayed retry ran
        $this->assertInstanceOf(SmsGateway::class, app(SmsGateway::class));
    }
}
