<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use App\Domain\Billing\Models\Plan;
use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Symfony\Component\Mailer\SentMessage;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;
use Tests\Support\StorefrontContent;

/** Phase 8.5 helpers: a live Starter shop, customers, campaign payloads, the fake SMS gateway and the array mailer. */
trait CampaignFixtures
{
    use CommerceFixtures, RoleFixtures, StorefrontContent {
        RoleFixtures::planFor insteadof CommerceFixtures;
    }

    /** Noon in Dhaka (06:00 UTC): outside quiet hours. */
    protected const NOON = '2026-11-24 06:00:00';

    protected function setUpCampaigns(bool $throttles = false): void
    {
        Carbon::setTestNow(Carbon::parse(self::NOON, 'UTC'));
        if (! $throttles) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
        config(['campaigns.sms_rate_per_second' => 0, 'campaigns.platform_sms_rate_per_second' => 0, 'campaigns.email_rate_per_second' => 0]);
    }

    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function campaignShop(string $plan = Plan::STARTER, string $slug = 'shop'): array
    {
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        $this->planFor($tenant, $plan);

        return [$user, $tenant, $store, $h];
    }

    /** A customer created through the API, then its counters set directly. @param array<string, mixed> $stats */
    protected function customer(array $h, Store $store, array $attributes = [], array $stats = []): Customer
    {
        static $n = 0;
        $n++;
        $id = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", $attributes + [
            'name' => "Rahim Uddin {$n}", 'phone' => sprintf('0171%07d', 1000 + $n), 'accepts_marketing' => true,
        ])->assertCreated()->json('data.id');
        if ($stats !== []) {
            $this->inTenant($store->tenant_id, fn () => Customer::query()->whereKey($id)->update($stats));
        }

        return $this->inTenant($store->tenant_id, fn () => Customer::query()->findOrFail($id));
    }

    /** @return array<string, mixed> */
    protected function campaignBody(array $override = []): array
    {
        return array_replace([
            'name' => 'Eid offer',
            'channel' => 'sms',
            'language' => 'en',
            'audience' => ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => false, 'ordered_within_days' => null]],
            'body' => 'Hi {name}, 10% off everything this week.',
        ], $override);
    }

    protected function cUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/campaigns".$suffix;
    }

    protected function createCampaign(array $h, Store $store, array $override = []): string
    {
        return $this->api($h, 'POST', $this->cUrl($store), $this->campaignBody($override))->assertCreated()->json('data.id');
    }

    protected function sendNow(array $h, Store $store, string $id, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->cUrl($store, "/{$id}/send"));
    }

    protected function scheduleAt(array $h, Store $store, string $id, string $at, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->cUrl($store, "/{$id}/schedule"), ['scheduled_at' => $at]);
    }

    protected function sms(): FakeSmsGateway
    {
        /** @var FakeSmsGateway $fake */
        $fake = app(SmsGateway::class);

        return $fake;
    }

    /** @return list<SentMessage> */
    protected function campaignMails(): array
    {
        return app('mail.manager')->mailer('campaigns')->getSymfonyTransport()->messages()->all();
    }

    protected function campaignRow(Tenant $tenant, string $id): Campaign
    {
        return $this->platformQuery(Campaign::class)->where('tenant_id', $tenant->id)->whereKey($id)->firstOrFail();
    }

    /** @return Collection<int, CampaignRecipient> */
    protected function recipientsOf(Tenant $tenant, string $campaignId): Collection
    {
        return $this->platformQuery(CampaignRecipient::class)->where('tenant_id', $tenant->id)->where('campaign_id', $campaignId)->orderBy('id')->get();
    }

    /** Extracts the unsubscribe code from a rendered SMS / email text. */
    protected function codeIn(string $text): string
    {
        preg_match('~/u/([A-Za-z0-9]{10})~', $text, $m);

        return $m[1] ?? '';
    }
}
