<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants;

use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;

/**
 * Cross-tenant merchant reads for the admin API (PHASE-8-1 §6.2, P8-6): every query runs on the admin connection
 * (`pgsql_admin`, BYPASSRLS, with RLS on; the default connection otherwise).
 */
final class TenantDirectory
{
    public const TABS = ['all', 'active', 'paying', 'trial', 'past_due', 'suspended'];

    public const SORTS = ['-created_at', 'created_at', 'name', '-name', 'current_period_end', '-current_period_end'];

    /** @throws ApiException 404 not_found */
    public static function find(string $tenantId): object
    {
        $row = AdminPresenter::isUlid($tenantId)
            ? PlatformDb::connection()->table('tenants')->where('id', strtolower($tenantId))->first() // cross-tenant: admin merchant detail
            : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /**
     * Tenants joined with their (single) store, current subscription and its plan; filters of `GET /admin/tenants`
     * except the status tab.
     *
     * @param  array<string, mixed>  $filter
     */
    public static function query(array $filter): Builder
    {
        $current = "'".implode("','", Subscription::CURRENT_STATUSES)."'";
        // cross-tenant: admin merchants list
        $query = PlatformDb::connection()->table('tenants as t')
            ->leftJoin('stores as s', 's.tenant_id', '=', 't.id')
            ->leftJoin('subscriptions as cs', function ($join) use ($current): void {
                $join->on('cs.tenant_id', '=', 't.id')->whereRaw("cs.status in ({$current})");
            })
            ->leftJoin('plans as p', 'p.id', '=', 'cs.plan_id');

        if (is_string($plan = $filter['plan'] ?? null) && $plan !== '') {
            $plan === Plan::FREE
                ? $query->where(fn (Builder $q) => $q->where('p.code', Plan::FREE)->orWhereNull('cs.id'))
                : $query->where('p.code', $plan);
        }
        if (is_string($from = $filter['created_from'] ?? null)) {
            $query->where('t.created_at', '>=', Carbon::parse($from)->startOfDay());
        }
        if (is_string($to = $filter['created_to'] ?? null)) {
            $query->where('t.created_at', '<=', Carbon::parse($to)->endOfDay());
        }
        if (is_string($q = $filter['q'] ?? null) && trim($q) !== '') {
            self::search($query, trim($q));
        }

        return $query;
    }

    /** Applies one status tab (`all` = none). */
    public static function tab(Builder $query, string $tab): Builder
    {
        return match ($tab) {
            'active' => $query->where('t.status', 'active'),
            'paying' => $query->where('cs.status', Subscription::ACTIVE)->where('p.code', '<>', Plan::FREE),
            'trial' => $query->where('cs.status', Subscription::TRIALING),
            'past_due' => $query->where('cs.status', Subscription::PAST_DUE),
            'suspended' => $query->where('t.status', 'suspended'),
            default => $query,
        };
    }

    /**
     * P8-17 matching on the merchants list: shop/tenant name and slug (contains), owner email (prefix), owner phone
     * (digits, `+88` stripped, prefix), hostname (contains) and exact ULID.
     */
    public static function search(Builder $query, string $q): void
    {
        $term = str_replace(['%', '_'], '', mb_strtolower($q));
        $digits = self::phoneDigits($q);
        $query->where(function (Builder $w) use ($q, $term, $digits): void {
            if (AdminPresenter::isUlid($q)) {
                $w->orWhere('t.id', strtolower($q))->orWhere('s.id', strtolower($q));
            }
            if ($term === '') {
                return;
            }
            $w->orWhereLike('t.name', "%{$term}%")->orWhereLike('s.name', "%{$term}%")->orWhereLike('s.slug', "{$term}%")
                ->orWhereExists(fn (Builder $e) => $e->from('tenant_users as tu')->join('users as u', 'u.id', '=', 'tu.user_id')
                    ->whereColumn('tu.tenant_id', 't.id')->where('tu.role', TenantUser::ROLE_OWNER)
                    ->where(function (Builder $o) use ($term, $digits): void {
                        $o->whereLike('u.email', "{$term}%");
                        if ($digits !== null) {
                            $o->orWhere('u.phone', 'like', "88{$digits}%")->orWhere('u.phone', 'like', "{$digits}%");
                        }
                    }))
                ->orWhereExists(fn (Builder $e) => $e->from('store_domains as d')->whereColumn('d.tenant_id', 't.id')
                    ->whereLike('d.hostname', "%{$term}%"));
        });
    }

    /** Digits of a phone query with a leading `88` stripped; null when it isn't phone-like (< 4 digits or letters). */
    public static function phoneDigits(string $q): ?string
    {
        if (preg_match('/^[\d\s+()-]+$/', $q) !== 1) {
            return null;
        }
        $digits = (string) preg_replace('/\D/', '', $q);
        if (str_starts_with($digits, '88')) {
            $digits = substr($digits, 2);
        }

        return strlen($digits) >= 4 ? $digits : null;
    }

    /**
     * AdminTenantSummary for each id, in the order given.
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function summaries(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $db = PlatformDb::connection(); // cross-tenant: admin merchant summaries
        $tenants = $db->table('tenants')->whereIn('id', $ids)->get()->keyBy('id');
        $stores = $db->table('stores')->whereIn('tenant_id', $ids)->get(['id', 'tenant_id', 'name', 'slug', 'status'])->keyBy('tenant_id');
        $hosts = $db->table('store_domains')->whereIn('tenant_id', $ids)->where('status', StoreDomain::STATUS_ACTIVE)
            ->orderByDesc('is_primary')->orderByRaw("case when type = 'platform' then 0 else 1 end")->get(['tenant_id', 'hostname'])
            ->groupBy('tenant_id')->map(fn ($rows) => (string) $rows->first()->hostname);
        $fallbackHosts = $db->table('store_domains')->whereIn('tenant_id', $ids)->where('type', StoreDomain::TYPE_PLATFORM)
            ->get(['tenant_id', 'hostname'])->keyBy('tenant_id');
        $owners = $db->table('tenant_users as tu')->join('users as u', 'u.id', '=', 'tu.user_id')
            ->whereIn('tu.tenant_id', $ids)->where('tu.role', TenantUser::ROLE_OWNER)->orderBy('tu.created_at')
            ->get(['tu.tenant_id', 'u.id', 'u.name', 'u.email', 'u.phone'])->keyBy('tenant_id');
        $subs = self::currentSubscriptions($ids);

        $out = [];
        foreach ($ids as $id) {
            $t = $tenants->get($id);
            if ($t === null) {
                continue;
            }
            $store = $stores->get($id);
            $owner = $owners->get($id);
            $sub = $subs[$id] ?? null;
            $out[] = [
                'id' => (string) $t->id,
                'name' => (string) $t->name,
                'status' => (string) $t->status,
                'store' => $store === null ? null : [
                    'id' => (string) $store->id, 'name' => (string) $store->name, 'slug' => (string) $store->slug,
                    'status' => (string) $store->status,
                    'primary_host' => (string) ($hosts->get($id) ?? $fallbackHosts->get($id)?->hostname ?? ''),
                ],
                'owner' => $owner === null ? null : [
                    'id' => (string) $owner->id, 'name' => (string) $owner->name, 'email' => (string) $owner->email,
                    'phone' => $owner->phone !== null ? (string) $owner->phone : null,
                ],
                'plan_code' => (string) ($sub->plan_code ?? Plan::FREE),
                'billing_interval' => $sub->billing_interval ?? null,
                'subscription_status' => $sub->status ?? null,
                'trial_ends_at' => AdminPresenter::ts($sub->trial_ends_at ?? null),
                'current_period_end' => AdminPresenter::ts($sub->current_period_end ?? null),
                'created_at' => AdminPresenter::ts($t->created_at),
            ];
        }

        return $out;
    }

    /**
     * The newest current (trialing|active|past_due) subscription per tenant, with its plan code.
     *
     * @param  list<string>  $ids
     * @return array<string, object>
     */
    public static function currentSubscriptions(array $ids): array
    {
        // cross-tenant: admin merchant subscriptions
        $rows = PlatformDb::connection()->table('subscriptions as s')->join('plans as p', 'p.id', '=', 's.plan_id')
            ->whereIn('s.tenant_id', $ids)->whereIn('s.status', Subscription::CURRENT_STATUSES)
            ->orderBy('s.created_at')->orderBy('s.id')
            ->get(['s.tenant_id', 's.status', 's.billing_interval', 's.trial_ends_at', 's.current_period_end', 'p.code as plan_code']);
        $out = [];
        foreach ($rows as $row) {
            $out[(string) $row->tenant_id] = $row; // later rows win = the newest
        }

        return $out;
    }
}
