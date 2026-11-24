<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\Audience\AudienceDefinition;
use App\Domain\Marketing\Audience\AudienceQuery;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\MessageSpec;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Marketing\Jobs\SendCampaignBatch;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\Sending\CampaignMessenger;
use App\Domain\Marketing\Sending\CampaignSendFailed;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The send pipeline (PHASE-8-5 §5.1). Runs inside the campaign's tenant (TenantAware jobs, console per tenant).
 *
 * 1. start(): audience snapshot when the campaign is `sending` (P85-9; one recipient per customer, deduped by address,
 *    fresh unsubscribe code each, SMS parts from the rendered text), exact allowance re-check (P85-14: not enough →
 *    `failed/limit`, nothing sent), zero → `failed/no_recipients`; then SendCampaignBatch jobs of ≤ 100 ids.
 * 2. sendBatch(): per recipient the §4.3 checks, then the at-most-once claim `queued → sending` (conditional UPDATE,
 *    P85-11), render, provider call, `sent` | `failed`. Quiet hours (P85-15): the batch stops and the recipients stay
 *    `queued`; `campaigns:dispatch-due` resumes the campaign after 09:00.
 * 3. finish(): no recipient `queued`/`sending` → `sent` (conditional UPDATE), counters recomputed from rows.
 */
final class CampaignPipeline
{
    public function __construct(
        private readonly CampaignMessenger $messenger,
        private readonly TenantContext $context,
    ) {}

    public function start(string $campaignId): void
    {
        $lock = Cache::lock(app(TenantCache::class)->key('campaigns:start'), 240);
        $lock->block(30, function () use ($campaignId) {
            $campaign = Campaign::query()->find($campaignId);
            if ($campaign === null || $campaign->status !== Campaign::SENDING) {
                return;
            }
            if (CampaignRecipient::query()->where('campaign_id', $campaign->id)->exists()) {
                return; // already materialized (a duplicated start): only (re)dispatch below
            }
            $store = Store::query()->find($campaign->store_id);
            if ($store === null || $store->status !== Store::STATUS_ACTIVE) {
                $this->fail($campaign, 'store_unavailable');

                return;
            }
            $tenant = $this->context->tenant();
            if ($tenant === null || CampaignAllowance::planHasNone($tenant, $campaign->channel)) {
                $this->fail($campaign, 'plan');

                return;
            }

            DB::transaction(fn () => $this->materialize($campaign, StoreBrand::of($store)));
            $count = CampaignRecipient::query()->where('campaign_id', $campaign->id)->count();
            $needed = $campaign->isSms() ? (int) CampaignRecipient::query()->where('campaign_id', $campaign->id)->sum('parts') : $count;
            Campaign::query()->whereKey($campaign->id)->update(['recipients_count' => $count, 'updated_at' => now()]);
            if ($count === 0) {
                $this->fail($campaign, 'no_recipients');

                return;
            }
            $summary = CampaignAllowance::summary($tenant, $campaign->channel, $needed);
            if ($summary['limit'] !== null && $summary['limit'] < $summary['used'] + $needed) {
                CampaignRecipient::query()->where('campaign_id', $campaign->id)->where('status', CampaignRecipient::QUEUED)
                    ->update(['status' => CampaignRecipient::SKIPPED, 'skip_reason' => 'plan', 'updated_at' => now()]);
                $this->fail($campaign, 'limit');
            }
        });

        $this->dispatchQueued($campaignId);
    }

    /** Dispatches SendCampaignBatch jobs for every `queued` recipient of a `sending` campaign. Returns the job count. */
    public function dispatchQueued(string $campaignId): int
    {
        if (Campaign::query()->whereKey($campaignId)->value('status') !== Campaign::SENDING) {
            return 0;
        }
        $jobs = 0;
        CampaignRecipient::query()->where('campaign_id', $campaignId)->where('status', CampaignRecipient::QUEUED)
            ->orderBy('id')->select('id')
            ->chunkById((int) config('campaigns.batch_size', 100), function ($rows) use ($campaignId, &$jobs) {
                dispatch(new SendCampaignBatch($campaignId, $rows->pluck('id')->all()));
                $jobs++;
            });
        if ($jobs === 0) {
            $this->finish($campaignId);
        }

        return $jobs;
    }

    /** @param list<string> $recipientIds */
    public function sendBatch(string $campaignId, array $recipientIds): void
    {
        $campaign = Campaign::query()->find($campaignId);
        if ($campaign === null) {
            return;
        }
        $store = Store::query()->find($campaign->store_id);
        if ($campaign->status !== Campaign::SENDING) {
            $this->skip($campaignId, $recipientIds, 'cancelled');
            $this->refreshCounters($campaignId);

            return;
        }
        if ($store === null || $store->status !== Store::STATUS_ACTIVE) {
            $this->skip($campaignId, $recipientIds, 'store_unavailable');
            $this->finish($campaignId);

            return;
        }
        $tenant = $this->context->tenant();
        if ($tenant === null || CampaignAllowance::planHasNone($tenant, $campaign->channel)) {
            $this->skip($campaignId, $recipientIds, 'plan');
            $this->finish($campaignId);

            return;
        }

        $brand = StoreBrand::of($store);
        $spec = MessageSpec::of($campaign);
        $timezone = (string) ($store->timezone ?: 'Asia/Dhaka');
        $deadline = microtime(true) + (int) config('campaigns.batch_budget_seconds', 150);
        foreach (array_chunk($recipientIds, 50) as $chunk) {
            $rows = CampaignRecipient::query()->where('campaign_id', $campaignId)->whereIn('id', $chunk)
                ->where('status', CampaignRecipient::QUEUED)->orderBy('id')->get();
            foreach ($rows as $recipient) {
                if (microtime(true) > $deadline) {
                    $this->refreshCounters($campaignId);

                    return; // time budget used: the rest stay queued, resumed by campaigns:dispatch-due
                }
                if (QuietHours::isQuiet(now(), $timezone)) {
                    $this->refreshCounters($campaignId);

                    return; // paused: stays queued, resumed by campaigns:dispatch-due after 09:00 (P85-15)
                }
                if (Campaign::query()->whereKey($campaignId)->value('status') !== Campaign::SENDING) {
                    $this->skip($campaignId, $recipientIds, 'cancelled');
                    $this->refreshCounters($campaignId);

                    return;
                }
                $this->sendOne($campaign, $spec, $brand, $recipient);
            }
        }
        $this->finish($campaignId);
    }

    /** §4.3 checks + claim + provider call for one recipient. */
    private function sendOne(Campaign $campaign, MessageSpec $spec, StoreBrand $brand, CampaignRecipient $recipient): void
    {
        $customer = $recipient->customer_id !== null ? Customer::query()->find($recipient->customer_id) : null;
        $reason = match (true) {
            Suppressions::exists($campaign->store_id, $campaign->channel, $recipient->address) => 'opted_out',
            $customer === null => 'customer_deleted',
            MarketingAddress::ofCustomer($customer, $campaign->channel) !== $recipient->address => 'address_changed',
            ! ($customer->accepts_marketing || $customer->orders_count >= 1) => 'not_eligible',
            default => null,
        };
        if ($reason !== null) {
            $this->skip($campaign->id, [$recipient->id], $reason);

            return;
        }

        // P85-11 at-most-once: only the worker that moves the row from queued to sending may call the provider.
        $claimed = CampaignRecipient::query()->whereKey($recipient->id)->where('status', CampaignRecipient::QUEUED)
            ->update(['status' => CampaignRecipient::SENDING, 'updated_at' => now()]);
        if ($claimed !== 1) {
            return;
        }

        $code = UnsubscribeCodes::generate();
        // The stored hash is the recipient's code; a fresh code per send keeps the plaintext out of the database
        // (the snapshot code was never stored) — the row's hash is replaced in the same UPDATE that marks it sent.
        $hash = UnsubscribeCodes::hash($code);
        $parts = 0;
        $providerId = null;
        $error = null;
        try {
            if ($campaign->isSms()) {
                $sms = CampaignRenderer::sms($spec, $brand, $customer->name, $code);
                $parts = $sms['parts'];
                $providerId = $this->messenger->sms($campaign->store_id, $recipient->address, $sms['text']);
                $this->sink($campaign, $recipient->address, null, $sms['text'], 'https://'.$brand->host.'/u/'.$code);
            } else {
                $email = CampaignRenderer::email($spec, $brand, $customer->name, $code);
                $parts = 1;
                $providerId = $this->messenger->email($brand, $recipient->address, $email);
                $this->sink($campaign, $recipient->address, $email['subject'], $email['text'], $email['unsubscribe_url']);
            }
        } catch (CampaignSendFailed $e) {
            $error = $e->errorCode;
        }

        CampaignRecipient::query()->whereKey($recipient->id)->where('status', CampaignRecipient::SENDING)->update($error === null
            ? ['status' => CampaignRecipient::SENT, 'sent_at' => now(), 'parts' => $parts, 'provider_message_id' => $providerId, 'unsubscribe_code_hash' => $hash, 'updated_at' => now()]
            : ['status' => CampaignRecipient::FAILED, 'error_code' => $error, 'parts' => 0, 'updated_at' => now()]);
        if ($campaign->isSms()) {
            SmsMessage::query()->create([
                'tenant_id' => $campaign->tenant_id,
                'to' => $recipient->address,
                'purpose' => 'campaign',
                'template' => 'campaign:'.$campaign->id,
                'provider_message_id' => $providerId,
                'status' => $error === null ? 'sent' : 'failed',
                'error' => $error,
            ]);
        }
    }

    /** Cancel effects (P85-17): remaining `queued` recipients become `skipped/cancelled`; sent ones stay sent. */
    public function cancelRemaining(string $campaignId): void
    {
        CampaignRecipient::query()->where('campaign_id', $campaignId)->where('status', CampaignRecipient::QUEUED)
            ->update(['status' => CampaignRecipient::SKIPPED, 'skip_reason' => 'cancelled', 'updated_at' => now()]);
        $this->refreshCounters($campaignId);
    }

    /** `sending` → `sent` once nothing is queued or in flight (conditional UPDATE); counters from rows. */
    public function finish(string $campaignId): void
    {
        $this->refreshCounters($campaignId);
        $open = CampaignRecipient::query()->where('campaign_id', $campaignId)
            ->whereIn('status', [CampaignRecipient::QUEUED, CampaignRecipient::SENDING])->exists();
        if (! $open) {
            Campaign::query()->whereKey($campaignId)->where('status', Campaign::SENDING)
                ->update(['status' => Campaign::SENT, 'completed_at' => now(), 'updated_at' => now()]);
        }
    }

    public function refreshCounters(string $campaignId): void
    {
        $rows = CampaignRecipient::query()->where('campaign_id', $campaignId)
            ->groupBy('status')->selectRaw('status, count(*) as n, coalesce(sum(parts), 0) as p')->get()->keyBy('status');
        $n = fn (string $s) => (int) ($rows[$s]->n ?? 0);
        $total = (int) $rows->sum(fn ($r) => (int) $r->n);
        if ($total === 0) {
            return; // pruned (P85-28) or not materialized: keep the stored counters
        }
        Campaign::query()->whereKey($campaignId)->update([
            'recipients_count' => $total,
            'sent_count' => $n(CampaignRecipient::SENT),
            'failed_count' => $n(CampaignRecipient::FAILED),
            'skipped_count' => $n(CampaignRecipient::SKIPPED),
            'parts_sent' => (int) ($rows[CampaignRecipient::SENT]->p ?? 0),
        ]);
    }

    /** @param list<string> $recipientIds skips the ones still `queued` */
    private function skip(string $campaignId, array $recipientIds, string $reason): void
    {
        foreach (array_chunk($recipientIds, 500) as $chunk) {
            CampaignRecipient::query()->where('campaign_id', $campaignId)->whereIn('id', $chunk)->where('status', CampaignRecipient::QUEUED)
                ->update(['status' => CampaignRecipient::SKIPPED, 'skip_reason' => $reason, 'updated_at' => now()]);
        }
    }

    private function fail(Campaign $campaign, string $reason): void
    {
        Campaign::query()->whereKey($campaign->id)->whereIn('status', [Campaign::SCHEDULED, Campaign::SENDING])
            ->update(['status' => Campaign::FAILED, 'failure_reason' => $reason, 'completed_at' => now(), 'updated_at' => now()]);
        $this->refreshCounters($campaign->id);
    }

    /** Inserts the snapshot (one row per customer, deduped by address). */
    private function materialize(Campaign $campaign, StoreBrand $brand): void
    {
        $audience = AudienceDefinition::from($campaign->audience);
        $spec = MessageSpec::of($campaign);
        $query = AudienceQuery::for($campaign->store_id, $campaign->channel, $audience)->recipients()
            ->select(['customers.id', 'customers.name', 'customers.phone', 'customers.email']);
        $seen = [];
        $now = now();
        $query->orderBy('customers.id')->chunkById((int) config('campaigns.insert_chunk', 1000), function ($customers) use ($campaign, $brand, $spec, &$seen, $now) {
            $rows = [];
            foreach ($customers as $customer) {
                $address = MarketingAddress::ofCustomer($customer, $campaign->channel);
                if ($address === null || isset($seen[$address])) {
                    continue;
                }
                $seen[$address] = true;
                $parts = $campaign->isSms() ? CampaignRenderer::sms($spec, $brand, $customer->name, CampaignRenderer::SAMPLE_CODE)['parts'] : 1;
                $rows[] = [
                    'id' => strtolower((string) Str::ulid()),
                    'tenant_id' => $campaign->tenant_id,
                    'store_id' => $campaign->store_id,
                    'campaign_id' => $campaign->id,
                    'customer_id' => $customer->id,
                    'channel' => $campaign->channel,
                    'address' => $address,
                    'status' => CampaignRecipient::QUEUED,
                    'parts' => $parts,
                    // P85-6: a random code per recipient, stored as sha256 only. The send replaces it with the code
                    // actually put in the message (the plaintext is never stored).
                    'unsubscribe_code_hash' => UnsubscribeCodes::hash(UnsubscribeCodes::generate().Str::random(16)),
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
            if ($rows !== []) {
                CampaignRecipient::query()->insertOrIgnore($rows);
            }
        }, 'customers.id', 'id');
    }

    private function sink(Campaign $campaign, string $to, ?string $subject, string $text, string $url): void
    {
        DevMessageSink::record($campaign->store_id, [
            'channel' => $campaign->channel, 'to' => $to, 'subject' => $subject, 'text' => $text,
            'unsubscribe_url' => $url, 'campaign_id' => $campaign->id, 'is_test' => false,
        ]);
    }
}
