<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Controllers;

use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Marketing\Suppressions;
use App\Domain\Marketing\UnsubscribeCodes;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\ResolvedStorefront;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-5 §4.2 storefront unsubscribe API (tenant from X-Storefront-Host + key; draft stores answer too, §8.6).
 * The code is looked up by sha256 inside the host's tenant and store (normal RLS path), so a code of store A on store
 * B's host is unknown (S117). GET never changes state; POST is idempotent; unknown and malformed codes get the same
 * 404 (S116). A test code (P85-26) answers `is_test: true` and never changes anything. Not audited (the suppression
 * row is the record). P85-QA-4 (PO): opt-out is per channel only — the link / one-click writes or removes ONLY that
 * channel's suppression and never touches `customers.accepts_marketing` (which would also block the other channel).
 *
 * PHASE-8-6 §8: a code is resolved from `campaign_recipients`, then `automation_run_steps` (a message step's code;
 * suppression source `link`, `campaign_id` null), then test codes (`campaign.test_sent` / `automation.test_sent`).
 * The response shape is unchanged.
 */
class StorefrontUnsubscribeController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function show(Request $request, string $code): JsonResponse
    {
        $store = $this->store($request);

        return $this->status($store, $this->resolve($store, $code));
    }

    public function update(Request $request, string $code): JsonResponse
    {
        $store = $this->store($request);
        $target = $this->resolve($store, $code);
        $input = $request->validate([
            'action' => ['required', 'string', 'in:unsubscribe,resubscribe'],
            'one_click' => ['sometimes', 'boolean'],
        ]);
        if (! $target['is_test'] && $target['address'] !== null) {
            $recipient = $target['recipient'];
            $channel = $target['channel'];
            $address = $target['address'];
            DB::transaction(function () use ($store, $recipient, $channel, $address, $input) {
                if ($input['action'] === 'unsubscribe') {
                    Suppressions::add($store->id, $channel, $address, MarketingSuppression::LINK, $recipient?->campaign_id);
                    if ($recipient !== null) {
                        $first = CampaignRecipient::query()->whereKey($recipient->id)->whereNull('unsubscribed_at')->update(['unsubscribed_at' => now(), 'updated_at' => now()]);
                        if ($first === 1) {
                            Campaign::query()->whereKey($recipient->campaign_id)->increment('unsubscribed_count');
                        }
                    }
                } else {
                    Suppressions::removeByCustomer($store->id, $channel, $address);
                }
            });
        }

        return $this->status($store, $target);
    }

    /** @return array{is_test: bool, channel: string, masked: string, address: string|null, recipient: CampaignRecipient|null} */
    private function resolve(Store $store, string $code): array
    {
        if (UnsubscribeCodes::valid($code)) {
            $hash = UnsubscribeCodes::hash($code);
            $recipient = CampaignRecipient::query()->where('store_id', $store->id)->where('unsubscribe_code_hash', $hash)->first();
            if ($recipient !== null) {
                return ['is_test' => false, 'channel' => $recipient->channel, 'masked' => MarketingAddress::mask($recipient->channel, $recipient->address), 'address' => $recipient->address, 'recipient' => $recipient];
            }
            $step = AutomationRunStep::query()->where('store_id', $store->id)->where('unsubscribe_code_hash', $hash)
                ->whereNotNull('channel')->whereNotNull('address')->first(['channel', 'address']);
            if ($step !== null) {
                return ['is_test' => false, 'channel' => (string) $step->channel, 'masked' => MarketingAddress::mask((string) $step->channel, (string) $step->address), 'address' => (string) $step->address, 'recipient' => null];
            }
            if (($test = UnsubscribeCodes::test($code, $store->id)) !== null) {
                return ['is_test' => true, 'channel' => $test['channel'], 'masked' => $test['to_masked'], 'address' => null, 'recipient' => null];
            }
        }

        throw new ApiException(404, 'unsubscribe_link_invalid', "This link isn't valid.");
    }

    /** @param array{is_test: bool, channel: string, masked: string, address: string|null, recipient: CampaignRecipient|null} $target */
    private function status(Store $store, array $target): JsonResponse
    {
        $unsubscribed = $target['address'] !== null
            && Suppressions::exists($store->id, $target['channel'], $target['address']);

        return new JsonResponse(['data' => [
            'channel' => $target['channel'],
            'masked_address' => $target['masked'],
            'status' => $unsubscribed ? 'unsubscribed' : 'subscribed',
            'is_test' => $target['is_test'],
            'store_name' => $store->name,
        ]], 200, self::NO_STORE);
    }

    private function store(Request $request): Store
    {
        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);

        return Store::query()->findOrFail($resolved->storeId);
    }
}
