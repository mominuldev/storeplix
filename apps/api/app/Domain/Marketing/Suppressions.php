<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Opt-out rules (PHASE-8-5 §4.1, P85-4, P85-5). A suppression is keyed by (store, channel, normalized address), so it
 * survives customer delete / re-create and CSV re-import (S114); `link` rows are customer-owned (S118).
 */
final class Suppressions
{
    public static function find(string $storeId, string $channel, string $address): ?MarketingSuppression
    {
        return MarketingSuppression::query()->where('store_id', $storeId)->where('channel', $channel)->where('address', $address)->first();
    }

    public static function exists(string $storeId, string $channel, string $address): bool
    {
        return MarketingSuppression::query()->where('store_id', $storeId)->where('channel', $channel)->where('address', $address)->exists();
    }

    /**
     * Adds a suppression; an existing row is kept as it is (idempotent; a `link` row is never downgraded). Returns the
     * row (existing or new).
     */
    public static function add(string $storeId, string $channel, string $address, string $source, ?string $campaignId = null, ?User $by = null): MarketingSuppression
    {
        if (($existing = self::find($storeId, $channel, $address)) !== null) {
            if ($source === MarketingSuppression::LINK && $existing->source !== MarketingSuppression::LINK) {
                // The customer's own opt-out takes ownership: the merchant can no longer remove it (P85-5).
                $existing->source = MarketingSuppression::LINK;
                $existing->campaign_id ??= $campaignId;
                $existing->save();
            }

            return $existing;
        }
        $row = new MarketingSuppression;
        $row->store_id = $storeId;
        $row->channel = $channel;
        $row->address = $address;
        $row->source = $source;
        $row->campaign_id = $campaignId;
        $row->created_by = $by?->getKey();
        $row->created_at = now();
        try {
            DB::transaction(fn () => $row->save());
        } catch (QueryException $e) {
            if (($existing = self::find($storeId, $channel, $address)) === null) {
                throw $e;
            }

            return $existing; // concurrent insert of the same key
        }

        return $row;
    }

    /** Merchant DELETE (§4.1): only `merchant` rows; customer-owned → 409 suppression_customer_owned. */
    public static function removeByMerchant(string $storeId, string $channel, string $address): bool
    {
        $row = self::find($storeId, $channel, $address);
        if ($row === null) {
            return false;
        }
        if ($row->source !== MarketingSuppression::MERCHANT) {
            throw new ApiException(409, 'suppression_customer_owned', 'This customer unsubscribed themselves. Only they can subscribe again, from the link in a message.');
        }
        MarketingSuppression::query()->whereKey($row->id)->where('source', MarketingSuppression::MERCHANT)->delete();

        return true;
    }

    /** Customer "Subscribe again" (§4.1): only `link` rows for that address + channel. */
    public static function removeByCustomer(string $storeId, string $channel, string $address): void
    {
        MarketingSuppression::query()->where('store_id', $storeId)->where('channel', $channel)->where('address', $address)
            ->where('source', MarketingSuppression::LINK)->delete();
    }

    /**
     * `Customer.marketing` (§4.1, computed). One query per customer.
     *
     * @return array{sms: string, email: string, unsubscribed_sms_at: string|null, unsubscribed_email_at: string|null, unsubscribed_source: array{sms: string|null, email: string|null}}
     */
    public static function customerMarketing(Customer $customer): array
    {
        $addresses = [
            Campaign::SMS => MarketingAddress::ofCustomer($customer, Campaign::SMS),
            Campaign::EMAIL => MarketingAddress::ofCustomer($customer, Campaign::EMAIL),
        ];
        $rows = collect();
        if (array_filter($addresses) !== []) {
            $rows = MarketingSuppression::query()->where('store_id', $customer->store_id)
                ->where(function ($q) use ($addresses) {
                    foreach (array_filter($addresses) as $channel => $address) {
                        $q->orWhere(fn ($w) => $w->where('channel', $channel)->where('address', $address));
                    }
                })->get()->keyBy('channel');
        }
        $eligible = $customer->accepts_marketing || $customer->orders_count >= 1;
        $out = ['unsubscribed_source' => []];
        foreach ($addresses as $channel => $address) {
            /** @var MarketingSuppression|null $row */
            $row = $address === null ? null : $rows->get($channel);
            $out[$channel] = match (true) {
                $address === null => 'no_address',
                $row !== null => 'unsubscribed',
                ! $eligible => 'not_eligible',
                default => 'subscribed',
            };
            $out["unsubscribed_{$channel}_at"] = $row !== null ? UserRef::iso($row->created_at) : null;
            $out['unsubscribed_source'][$channel] = $row?->source;
        }

        return [
            'sms' => $out['sms'],
            'email' => $out['email'],
            'unsubscribed_sms_at' => $out['unsubscribed_sms_at'],
            'unsubscribed_email_at' => $out['unsubscribed_email_at'],
            'unsubscribed_source' => ['sms' => $out['unsubscribed_source']['sms'], 'email' => $out['unsubscribed_source']['email']],
        ];
    }
}
