<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Identity\Models\User;
use App\Domain\Marketing\Audience\AudienceDefinition;
use App\Domain\Marketing\Audience\AudienceQuery;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\MessageSpec;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Marketing\Jobs\StartCampaign;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Sending\CampaignMessenger;
use App\Domain\Marketing\Sending\CampaignSendFailed;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\ValidationException;

/**
 * Campaign CRUD and the merchant side of the state machine (PHASE-8-5 §6.1, P85-14 … P85-17, P85-24, P85-26, P85-27).
 * Every transition is a row-locked read + write in one transaction, so two tabs can't both schedule/send/cancel.
 */
final class CampaignService
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
        private readonly CampaignPipeline $pipeline,
        private readonly CampaignMessenger $messenger,
    ) {}

    /** @param array<string, mixed> $input validated CampaignRequest input */
    public function create(Store $store, array $input, ?User $user): Campaign
    {
        self::assertLive($store);

        return DB::transaction(function () use ($store, $input, $user) {
            $this->assertOpenBound($store);
            $campaign = new Campaign;
            $campaign->store_id = $store->id;
            $campaign->created_by = $user?->getKey();
            $this->fill($campaign, $input, $store);
            $campaign->save();
            $this->audit->log('campaign.created', $campaign, ['channel' => $campaign->channel]);

            return $campaign;
        });
    }

    /** @param array<string, mixed> $input */
    public function update(Store $store, Campaign $campaign, array $input, int $revision): Campaign
    {
        return DB::transaction(function () use ($store, $campaign, $input, $revision) {
            $locked = $this->lock($campaign);
            if (! in_array($locked->status, Campaign::EDITABLE, true)) {
                throw self::invalidState('Only draft and scheduled campaigns can be edited.');
            }
            if ($locked->revision !== $revision) {
                throw StoreThemeService::conflict();
            }
            $this->fill($locked, $input, $store);
            if ($locked->status === Campaign::SCHEDULED) {
                // P85-17: editing a scheduled campaign re-validates the schedule and the allowance.
                self::assertLive($store);
                $this->assertSchedule($store, $locked->scheduled_at);
                $this->assertSendable($store, $locked);
            }
            if ($locked->isDirty()) {
                $locked->revision++;
                $locked->save();
            }

            return $locked;
        });
    }

    public function delete(Campaign $campaign): void
    {
        DB::transaction(function () use ($campaign) {
            $locked = $this->lock($campaign);
            if ($locked->status !== Campaign::DRAFT) {
                throw self::invalidState('Only drafts can be deleted. Cancel the campaign instead.');
            }
            $locked->delete();
            $this->audit->log('campaign.deleted', $locked, ['name' => $locked->name]);
        });
    }

    public function duplicate(Store $store, Campaign $campaign, ?User $user): Campaign
    {
        return DB::transaction(function () use ($store, $campaign, $user) {
            $this->assertOpenBound($store);
            $copy = new Campaign;
            $copy->store_id = $store->id;
            $copy->created_by = $user?->getKey();
            $copy->name = mb_substr($campaign->name, 0, 80 - 7).' (copy)';
            foreach (['channel', 'language', 'audience', 'body', 'subject', 'coupon_id', 'product_id'] as $field) {
                $copy->{$field} = $campaign->{$field};
            }
            $copy->save();
            $this->audit->log('campaign.created', $copy, ['channel' => $copy->channel, 'duplicated_from' => $campaign->id]);

            return $copy;
        });
    }

    public function schedule(Store $store, Campaign $campaign, Carbon $at): Campaign
    {
        self::assertLive($store);

        return DB::transaction(function () use ($store, $campaign, $at) {
            $locked = $this->lock($campaign);
            if (! in_array($locked->status, Campaign::EDITABLE, true)) {
                throw self::invalidState('Only draft or scheduled campaigns can be scheduled.');
            }
            $this->assertSchedule($store, $at);
            $this->assertSendable($store, $locked);
            $locked->status = Campaign::SCHEDULED;
            $locked->scheduled_at = $at;
            $locked->failure_reason = null;
            $locked->revision++;
            $locked->save();
            $this->audit->log('campaign.scheduled', $locked, ['scheduled_at' => $at->toIso8601ZuluString()]);

            return $locked;
        });
    }

    /**
     * "Send now" (§6.1): `sending` at once, or — when the store already has 3 campaigns sending (P85-27) — `scheduled`
     * for now, started by `campaigns:dispatch-due` as soon as a slot frees.
     */
    public function sendNow(Store $store, Campaign $campaign): Campaign
    {
        self::assertLive($store);
        $campaign = DB::transaction(function () use ($store, $campaign) {
            $locked = $this->lock($campaign);
            if (! in_array($locked->status, Campaign::EDITABLE, true)) {
                throw self::invalidState('Only draft or scheduled campaigns can be sent.');
            }
            $now = now();
            if (QuietHours::isQuiet($now, self::timezone($store))) {
                throw self::quietHours($store, $now);
            }
            $this->assertSendable($store, $locked);
            $slots = Campaign::query()->where('store_id', $store->id)->where('status', Campaign::SENDING)->count();
            if ($slots >= (int) config('campaigns.max_sending_per_store', 3)) {
                $locked->status = Campaign::SCHEDULED;
                $locked->scheduled_at = $now;
            } else {
                $locked->status = Campaign::SENDING;
                $locked->started_at = $now;
            }
            $locked->failure_reason = null;
            $locked->revision++;
            $locked->save();
            $this->audit->log('campaign.sent', $locked, ['channel' => $locked->channel]);

            return $locked;
        });

        return $campaign;
    }

    /** Starts the pipeline for a campaign that just entered `sending` (after the response is built). */
    public function dispatchStart(Campaign $campaign): void
    {
        if ($campaign->status === Campaign::SENDING) {
            dispatch(new StartCampaign($campaign->id))->afterCommit();
        }
    }

    public function unschedule(Campaign $campaign): Campaign
    {
        return DB::transaction(function () use ($campaign) {
            $locked = $this->lock($campaign);
            if ($locked->status !== Campaign::SCHEDULED) {
                throw self::invalidState('Only scheduled campaigns can be unscheduled.');
            }
            $locked->status = Campaign::DRAFT;
            $locked->revision++;
            $locked->save();
            $this->audit->log('campaign.unscheduled', $locked);

            return $locked;
        });
    }

    public function cancel(Campaign $campaign): Campaign
    {
        $locked = DB::transaction(function () use ($campaign) {
            $locked = $this->lock($campaign);
            if (! in_array($locked->status, Campaign::OPEN, true)) {
                throw self::invalidState('This campaign has already finished.');
            }
            $from = $locked->status;
            $locked->status = Campaign::CANCELLED;
            $locked->cancelled_at = now();
            $locked->revision++;
            $locked->save();
            $this->audit->log('campaign.cancelled', $locked, ['from' => $from]);

            return $locked;
        });
        $this->pipeline->cancelRemaining($locked->id);

        return $locked->refresh();
    }

    /**
     * P85-26 "Send test to me": the real render with sample values and a test unsubscribe code, to the actor's verified
     * phone (SMS) or account email; counts toward the allowance; 5 per hour per user; audited.
     *
     * @return array{to_masked: string}
     */
    public function test(Store $store, Campaign $campaign, User $user): array
    {
        $tenant = $this->context->tenant() ?? throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        self::assertLive($store);
        if (! in_array($campaign->status, Campaign::OPEN, true)) {
            throw self::invalidState('This campaign has already finished.');
        }
        if (CampaignAllowance::planHasNone($tenant, $campaign->channel)) {
            CampaignAllowance::assertFits($tenant, $campaign->channel, 1); // Free: 402 before anything else
        }
        $spec = MessageSpec::of($campaign);
        $this->assertMessage($store, $spec, $campaign->coupon_id, $campaign->product_id);

        if ($campaign->isSms()) {
            $to = $user->phone_verified_at !== null ? MarketingAddress::normalize(Campaign::SMS, $user->phone) : null;
            if ($to === null) {
                throw ValidationException::withMessages(['channel' => ['Verify your phone number in your account to get test SMS.']]);
            }
        } else {
            $to = MarketingAddress::normalize(Campaign::EMAIL, $user->email)
                ?? throw ValidationException::withMessages(['channel' => ['Your account has no valid email address.']]);
        }

        $limiterKey = app(TenantCache::class)->key('campaigns-test:'.$user->getKey());
        $perHour = (int) config('campaigns.test_sends_per_hour', 5);
        if (RateLimiter::tooManyAttempts($limiterKey, $perHour)) {
            throw new ApiException(429, 'rate_limited', 'You can send 5 test messages an hour. Try again later.', null, RateLimiter::availableIn($limiterKey));
        }

        $brand = StoreBrand::of($store);
        $code = UnsubscribeCodes::generate();
        $name = (string) $user->name;
        if ($campaign->isSms()) {
            $sms = CampaignRenderer::sms($spec, $brand, $name, $code);
            CampaignAllowance::assertFits($tenant, Campaign::SMS, $sms['parts']);
            RateLimiter::hit($limiterKey, 3600);
            $error = null;
            $providerId = null;
            try {
                $providerId = $this->messenger->sms($store->id, $to, $sms['text']);
            } catch (CampaignSendFailed $e) {
                $error = $e->errorCode;
                report($e);
            }
            SmsMessage::query()->create([
                'tenant_id' => $campaign->tenant_id, 'to' => $to, 'purpose' => 'campaign', 'template' => 'campaign:'.$campaign->id.':test',
                'provider_message_id' => $providerId, 'status' => $error === null ? 'sent' : 'failed', 'error' => $error,
            ]);
            if ($error !== null) {
                throw new ApiException(502, 'provider_error', 'The SMS provider could not send the test message. Try again in a moment.');
            }
            $this->audit->log('campaign.test_sent', $campaign, ['channel' => Campaign::SMS, 'parts' => $sms['parts'], 'store_id' => $store->id, 'to_masked' => MarketingAddress::mask(Campaign::SMS, $to), 'code_hash' => UnsubscribeCodes::hash($code)]);
            DevMessageSink::record($store->id, ['channel' => Campaign::SMS, 'to' => $to, 'subject' => null, 'text' => $sms['text'],
                'unsubscribe_url' => 'https://'.$brand->host.'/u/'.$code, 'campaign_id' => $campaign->id, 'is_test' => true]);
        } else {
            $email = CampaignRenderer::email($spec, $brand, $name, $code);
            CampaignAllowance::assertFits($tenant, Campaign::EMAIL, 1);
            RateLimiter::hit($limiterKey, 3600);
            try {
                $this->messenger->email($brand, $to, $email);
            } catch (CampaignSendFailed $e) {
                report($e);

                throw new ApiException(502, 'provider_error', 'The email could not be sent. Try again in a moment.');
            }
            $this->audit->log('campaign.test_sent', $campaign, ['channel' => Campaign::EMAIL, 'parts' => 1, 'store_id' => $store->id, 'to_masked' => MarketingAddress::mask(Campaign::EMAIL, $to), 'code_hash' => UnsubscribeCodes::hash($code)]);
            DevMessageSink::record($store->id, ['channel' => Campaign::EMAIL, 'to' => $to, 'subject' => $email['subject'], 'text' => $email['text'],
                'unsubscribe_url' => $email['unsubscribe_url'], 'campaign_id' => $campaign->id, 'is_test' => true]);
        }

        return ['to_masked' => MarketingAddress::mask($campaign->channel, $to)];
    }

    /**
     * Estimate for the composer (§6.1 `/campaigns/estimate`).
     *
     * @return array{recipients: int, parts_per_recipient: int, total_parts: int, encoding: string|null, characters: int, allowance: array{limit: int|null, used: int, remaining: int|null, after: int|null}}
     */
    public function estimate(Store $store, MessageSpec $spec, AudienceDefinition $audience): array
    {
        $tenant = $this->context->tenant() ?? throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        $recipients = AudienceQuery::for($store->id, $spec->channel, $audience)->recipients()->count();
        if ($spec->channel === Campaign::SMS) {
            $sms = CampaignRenderer::sms($spec, StoreBrand::of($store), CampaignRenderer::SAMPLE_NAME, CampaignRenderer::SAMPLE_CODE);
            $per = $sms['parts'];
            $encoding = $sms['encoding'];
            $characters = $sms['units'];
        } else {
            $per = 1;
            $encoding = null;
            $characters = mb_strlen($spec->body);
        }
        $total = $recipients * $per;

        return [
            'recipients' => $recipients,
            'parts_per_recipient' => $per,
            'total_parts' => $total,
            'encoding' => $encoding,
            'characters' => $characters,
            'allowance' => CampaignAllowance::summary($tenant, $spec->channel, $total),
        ];
    }

    /**
     * Message rules shared by save, estimate and send (P85-18 … P85-20): merge fields, coupon/product of this store,
     * active coupon, ≤ 5 SMS parts with the sample render.
     */
    public function assertMessage(Store $store, MessageSpec $spec, ?string $couponId, ?string $productId): void
    {
        CampaignRenderer::assertKnownFields($spec->body, (string) $spec->subject);
        if (CampaignRenderer::usesField($spec, '{coupon}') && $couponId === null) {
            throw ValidationException::withMessages(['coupon_id' => ['Choose the coupon for {coupon}.']]);
        }
        if (CampaignRenderer::usesField($spec, '{product}') && $productId === null) {
            throw ValidationException::withMessages(['product_id' => ['Choose the product for {product}.']]);
        }
        if ($couponId !== null) {
            $coupon = Coupon::query()->where('store_id', $store->id)->whereKey($couponId)->first();
            if ($coupon === null) {
                throw ValidationException::withMessages(['coupon_id' => ['Choose one of your coupons.']]);
            }
            if ($coupon->displayStatus() !== 'active') {
                throw new ApiException(422, 'campaign_coupon_inactive', "The coupon {$coupon->code} isn't active. Activate it or choose another coupon.", ['coupon_id' => ["The coupon {$coupon->code} isn't active."]]);
            }
        }
        if ($productId !== null && ! Product::query()->where('store_id', $store->id)->whereKey($productId)->exists()) {
            throw ValidationException::withMessages(['product_id' => ['Choose one of your products.']]);
        }
        if ($spec->channel === Campaign::SMS) {
            $max = (int) config('campaigns.sms_max_parts', 5);
            $parts = CampaignRenderer::sms($spec, StoreBrand::of($store), CampaignRenderer::SAMPLE_NAME, CampaignRenderer::SAMPLE_CODE)['parts'];
            if ($parts > $max) {
                throw new ApiException(422, 'campaign_too_long', "This SMS is {$parts} parts long; the maximum is {$max} (the shop name and the opt-out link count too).", ['parts' => $parts, 'max_parts' => $max]);
            }
        }
    }

    /** Schedule / send checks: message, ≥ 1 recipient (422 campaign_no_recipients), allowance (402, P85-14). */
    private function assertSendable(Store $store, Campaign $campaign): void
    {
        $tenant = $this->context->tenant() ?? throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        $spec = MessageSpec::of($campaign);
        $this->assertMessage($store, $spec, $campaign->coupon_id, $campaign->product_id);
        if (CampaignAllowance::planHasNone($tenant, $campaign->channel)) {
            CampaignAllowance::assertFits($tenant, $campaign->channel, 1);
        }
        $estimate = $this->estimate($store, $spec, AudienceDefinition::from($campaign->audience));
        if ($estimate['recipients'] === 0) {
            throw new ApiException(422, 'campaign_no_recipients', 'Nobody in this audience can get this message.');
        }
        CampaignAllowance::assertFits($tenant, $campaign->channel, $estimate['total_parts']);
    }

    /** P85-16 bounds + P85-15 quiet hours (store time). */
    private function assertSchedule(Store $store, ?Carbon $at): void
    {
        if ($at === null) {
            throw ValidationException::withMessages(['scheduled_at' => ['Choose when to send.']]);
        }
        $now = now();
        $min = (int) config('campaigns.schedule_min_lead_minutes', 5);
        $maxDays = (int) config('campaigns.schedule_max_days', 90);
        if ($at->lt($now->copy()->addMinutes($min))) {
            throw ValidationException::withMessages(['scheduled_at' => ["Schedule at least {$min} minutes from now."]]);
        }
        if ($at->gt($now->copy()->addDays($maxDays))) {
            throw ValidationException::withMessages(['scheduled_at' => ["Schedule at most {$maxDays} days ahead."]]);
        }
        if (QuietHours::isQuiet($at, self::timezone($store))) {
            throw self::quietHours($store, $at);
        }
    }

    /** @param array<string, mixed> $input */
    private function fill(Campaign $campaign, array $input, Store $store): void
    {
        foreach (['name', 'channel', 'language', 'body'] as $field) {
            if (array_key_exists($field, $input)) {
                $campaign->{$field} = $input[$field];
            }
        }
        if (array_key_exists('audience', $input)) {
            $campaign->audience = AudienceDefinition::from($input['audience'])->toArray();
        }
        foreach (['subject', 'coupon_id', 'product_id'] as $field) {
            if (array_key_exists($field, $input)) {
                $campaign->{$field} = $input[$field] !== null ? (is_string($input[$field]) && str_ends_with($field, '_id') ? strtolower($input[$field]) : $input[$field]) : null;
            }
        }
        if (array_key_exists('scheduled_at', $input)) {
            $campaign->scheduled_at = $input['scheduled_at'] !== null ? Carbon::parse($input['scheduled_at'])->utc() : null;
        }
        if ($campaign->channel === Campaign::SMS) {
            $campaign->subject = null;
        } elseif ($campaign->subject === null || trim($campaign->subject) === '') {
            throw ValidationException::withMessages(['subject' => ['Enter a subject for the email.']]);
        }
        if ($campaign->channel === Campaign::EMAIL && mb_strlen($campaign->body) > (int) config('campaigns.email_body_max', 5000)) {
            throw ValidationException::withMessages(['body' => ['The email can be at most 5,000 characters.']]);
        }
        $this->assertMessage($store, MessageSpec::from(
            $campaign->channel, $campaign->language, $campaign->body, $campaign->subject,
            $campaign->coupon_id !== null ? Coupon::query()->where('store_id', $store->id)->whereKey($campaign->coupon_id)->first() : null,
            $campaign->product_id !== null ? Product::query()->where('store_id', $store->id)->whereKey($campaign->product_id)->first() : null,
        ), $campaign->coupon_id, $campaign->product_id);
    }

    private function assertOpenBound(Store $store): void
    {
        $max = (int) config('campaigns.max_open_per_store', 50);
        if (Campaign::query()->where('store_id', $store->id)->whereIn('status', Campaign::OPEN)->count() >= $max) {
            throw new ApiException(422, 'limit_reached', "A store can have at most {$max} draft, scheduled or sending campaigns. Delete or cancel one first.", ['name' => ["A store can have at most {$max} open campaigns."]]);
        }
    }

    private function lock(Campaign $campaign): Campaign
    {
        return Campaign::query()->whereKey($campaign->id)->lockForUpdate()->firstOrFail();
    }

    public static function assertLive(Store $store): void
    {
        if ($store->status !== Store::STATUS_ACTIVE) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Campaigns open after you go live.");
        }
    }

    private static function invalidState(string $message): ApiException
    {
        return new ApiException(409, 'invalid_state_transition', $message);
    }

    private static function quietHours(Store $store, Carbon $at): ApiException
    {
        $from = QuietHours::allowedFrom($at, self::timezone($store));

        return new ApiException(422, 'campaign_quiet_hours', 'Campaigns can’t start between 9 PM and 9 AM shop time. Pick a time from 9 AM.', ['allowed_from' => $from->toIso8601ZuluString()]);
    }

    private static function timezone(Store $store): string
    {
        return (string) ($store->timezone ?: 'Asia/Dhaka');
    }
}
