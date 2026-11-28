<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Credits;

use App\Domain\Billing\FeatureGate;
use App\Domain\Sms\Charging\Charge;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/** PHASE-8-9A §5 helpers: buy a pack through the API + fake gateway, charge an SMS, tune the plan allowance. */
trait SmsCreditFixtures
{
    /** @param array<string, string> $h */
    protected function buyPack(array $h, string $pack = 'credits_1000', string $provider = 'bkash', ?string $key = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => $key ?? (string) Str::ulid()])
            ->postJson('/api/v1/billing/sms-credits/purchase', ['pack' => $pack, 'provider' => $provider]);
    }

    /** purchase → fake page "pay" → signed return. @return array{invoice: string, payment: string} */
    protected function buyAndPay(array $h, Tenant $tenant, string $pack = 'credits_1000', string $outcome = 'pay'): array
    {
        $res = $this->buyPack($h, $pack)->assertCreated();
        $ids = ['invoice' => (string) $res->json('data.invoice.id'), 'payment' => (string) $res->json('data.payment.id')];
        $this->fakeOutcome($tenant, $ids['payment'], $outcome)->assertStatus(303);

        return $ids;
    }

    /** Sets the plan's `sms_per_month` for every plan code given (and forgets the cached plan). */
    protected function smsAllowance(Tenant $tenant, string $plan, ?int $perMonth): void
    {
        $limits = json_decode((string) $this->platformTable('plans')->where('code', $plan)->value('limits'), true);
        $limits['sms_per_month'] = $perMonth;
        $this->platformTable('plans')->where('code', $plan)->update(['limits' => json_encode($limits)]);
        FeatureGate::forget($tenant->id);
    }

    /** Creates a queued transactional SMS row and charges it. */
    protected function chargeSms(Tenant $tenant, Store $store, string $text = 'Shop: Order SP-1 is confirmed.'): Charge
    {
        return $this->inTenant($tenant, function () use ($tenant, $store, $text) {
            $message = SmsMessage::query()->create(['tenant_id' => $tenant->id, 'store_id' => $store->id, 'to' => '8801711552211',
                'purpose' => 'order_confirmed', 'template' => 'order_confirmed.en', 'status' => SmsMessage::QUEUED]);

            return app(SmsCharger::class)->charge($message, $text);
        });
    }
}
