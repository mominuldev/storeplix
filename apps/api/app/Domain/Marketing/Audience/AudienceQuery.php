<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Audience;

use App\Domain\Customers\CustomerRisk;
use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\Models\Campaign;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Builds customer queries for a store, channel and audience (PHASE-8-5 §3.2, §3.3, P85-3, P85-10, P85-25).
 *
 * Exclusion buckets are disjoint and applied in this order (each bucket counts only customers not already excluded):
 * no_address → opted_out → not_eligible → risky (when `exclude.risky`) → recent_orders (when
 * `exclude.ordered_within_days`). recipients = matched − Σ excluded.
 */
final class AudienceQuery
{
    public function __construct(
        private readonly string $storeId,
        private readonly string $channel,
        private readonly AudienceDefinition $audience,
        private readonly Carbon $now,
    ) {}

    public static function for(string $storeId, string $channel, AudienceDefinition $audience, ?Carbon $now = null): self
    {
        return new self($storeId, $channel, $audience, $now ?? now());
    }

    /** The segment, before any exclusion. */
    public function matched(): Builder
    {
        $q = Customer::query()->where('customers.store_id', $this->storeId);
        $p = $this->audience->segmentParams;
        match ($this->audience->segment) {
            'repeat_inactive' => $q->where('orders_count', '>=', $p['min_orders'])
                ->whereNotNull('last_order_at')->where('last_order_at', '<', $this->now->copy()->subDays($p['inactive_days'])),
            'vip' => $q->where('total_spent_amount', '>=', $p['min_spent_amount']),
            'new_customers' => $q->where('orders_count', '>=', 1)->where('customers.created_at', '>=', $this->now->copy()->subDays($p['days'])),
            'one_time' => $q->where('orders_count', 1),
            'district' => $q->whereIn(DB::raw('lower(district)'), array_map('mb_strtolower', $p['districts'])),
            'tag' => $q->whereJsonContains('tags', $p['tag']),
            default => null,
        };

        return $q;
    }

    /** Customers that get the message (every exclusion applied). */
    public function recipients(): Builder
    {
        return $this->apply($this->matched(), ['no_address', 'opted_out', 'not_eligible', 'risky', 'recent_orders']);
    }

    /**
     * @return array{matched: int, excluded: array{risky: int, recent_orders: int, opted_out: int, no_address: int, not_eligible: int}, recipients: int, risk_breakdown: array{good: float, careful: float, risky: float}}
     */
    public function preview(): array
    {
        $matched = $this->matched()->count();
        $order = ['no_address', 'opted_out', 'not_eligible', 'risky', 'recent_orders'];
        $excluded = ['risky' => 0, 'recent_orders' => 0, 'opted_out' => 0, 'no_address' => 0, 'not_eligible' => 0];
        $applied = [];
        foreach ($order as $bucket) {
            if (! $this->active($bucket)) {
                continue;
            }
            $q = $this->apply($this->matched(), $applied);
            $excluded[$bucket] = $this->only($q, $bucket)->count();
            $applied[] = $bucket;
        }
        $recipients = $matched - array_sum($excluded);

        $risk = ['good' => 0.0, 'careful' => 0.0, 'risky' => 0.0];
        if ($recipients > 0) {
            $risky = $this->recipients()->whereRaw(CustomerRisk::riskySql())->count();
            $careful = $this->recipients()->whereRaw(CustomerRisk::carefulSql())->count();
            $risk = [
                'good' => round(($recipients - $risky - $careful) * 100 / $recipients, 1),
                'careful' => round($careful * 100 / $recipients, 1),
                'risky' => round($risky * 100 / $recipients, 1),
            ];
        }

        return ['matched' => $matched, 'excluded' => $excluded, 'recipients' => $recipients, 'risk_breakdown' => $risk];
    }

    /** The address column of the channel on `customers`. */
    public function addressColumn(): string
    {
        return $this->channel === Campaign::SMS ? 'customers.phone' : 'customers.email';
    }

    /** SQL: a suppression row exists for the customer's address on this channel in this store. */
    public static function suppressedSql(string $channel): string
    {
        $address = $channel === Campaign::SMS ? 'customers.phone' : 'lower(customers.email)';

        return "exists (select 1 from marketing_suppressions ms where ms.store_id = customers.store_id and ms.channel = '"
            .($channel === Campaign::SMS ? 'sms' : 'email')."' and ms.address = {$address})";
    }

    private function active(string $bucket): bool
    {
        return match ($bucket) {
            'risky' => $this->audience->exclude['risky'],
            'recent_orders' => $this->audience->exclude['ordered_within_days'] !== null,
            default => true,
        };
    }

    /** @param list<string> $buckets removes the customers of each bucket */
    private function apply(Builder $q, array $buckets): Builder
    {
        foreach ($buckets as $bucket) {
            if (! $this->active($bucket)) {
                continue;
            }
            match ($bucket) {
                'no_address' => $q->whereNotNull($this->addressColumn())->where($this->addressColumn(), '<>', ''),
                'opted_out' => $q->whereRaw('NOT '.self::suppressedSql($this->channel)),
                'not_eligible' => $q->where(fn (Builder $w) => $w->where('accepts_marketing', true)->orWhere('orders_count', '>=', 1)),
                'risky' => $q->whereRaw('NOT '.CustomerRisk::riskySql()),
                'recent_orders' => $q->where(fn (Builder $w) => $w->whereNull('last_order_at')
                    ->orWhere('last_order_at', '<', $this->now->copy()->subDays((int) $this->audience->exclude['ordered_within_days']))),
            };
        }

        return $q;
    }

    /** Keeps only the customers of one bucket. */
    private function only(Builder $q, string $bucket): Builder
    {
        return match ($bucket) {
            'no_address' => $q->where(fn (Builder $w) => $w->whereNull($this->addressColumn())->orWhere($this->addressColumn(), '')),
            'opted_out' => $q->whereRaw(self::suppressedSql($this->channel)),
            'not_eligible' => $q->where('accepts_marketing', false)->where('orders_count', '<', 1),
            'risky' => $q->whereRaw(CustomerRisk::riskySql()),
            'recent_orders' => $q->whereNotNull('last_order_at')
                ->where('last_order_at', '>=', $this->now->copy()->subDays((int) $this->audience->exclude['ordered_within_days'])),
        };
    }
}
