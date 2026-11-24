<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Controllers;

use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\MarketingSuppression;
use App\Domain\Marketing\Suppressions;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-5 §4.1 / §6.1 merchant "Stop marketing messages" toggle (perm:customers.edit). POST adds a `merchant`
 * suppression (idempotent; an existing `link` row is kept); DELETE removes only a `merchant` row (customer-owned →
 * 409 suppression_customer_owned, S118; nothing to remove → 200). Both answer `CustomerMarketing` and are audited.
 */
class CustomerMarketingController
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function store(Request $request, Store $store, string $customer): JsonResponse
    {
        $row = self::find($store, $customer);
        $input = $request->validate(['channel' => ['required', 'string', Rule::in(Campaign::CHANNELS)]]);
        $address = MarketingAddress::ofCustomer($row, $input['channel'])
            ?? throw ValidationException::withMessages(['channel' => ['This customer has no address for this channel.']]);
        DB::transaction(function () use ($store, $row, $input, $address, $request) {
            Suppressions::add($store->id, $input['channel'], $address, MarketingSuppression::MERCHANT, null, $request->user());
            $this->audit->log('customer.marketing_opted_out', $row, ['channel' => $input['channel']]);
        });

        return new JsonResponse(['data' => Suppressions::customerMarketing($row)]);
    }

    public function destroy(Store $store, string $customer, string $channel): JsonResponse
    {
        $row = self::find($store, $customer);
        if (! in_array($channel, Campaign::CHANNELS, true)) {
            throw ValidationException::withMessages(['channel' => ['Choose sms or email.']]);
        }
        $address = MarketingAddress::ofCustomer($row, $channel);
        if ($address !== null) {
            DB::transaction(function () use ($store, $row, $channel, $address) {
                if (Suppressions::removeByMerchant($store->id, $channel, $address)) {
                    $this->audit->log('customer.marketing_opt_out_removed', $row, ['channel' => $channel]);
                }
            });
        }

        return new JsonResponse(['data' => Suppressions::customerMarketing($row)]);
    }

    private static function find(Store $store, string $id): Customer
    {
        return Customer::query()->where('store_id', $store->id)->whereKey(strtolower($id))->firstOrFail();
    }
}
