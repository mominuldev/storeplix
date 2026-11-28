<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Billing\Models\Subscription;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-9B P89B-17 / P89B-20: who a broadcast reaches. One recipient per tenant = its owner. Skipped: suspended
 * tenants, owner without a verified phone, opted-out owners, tenants at the weekly cap (2 promotional SMS in any rolling
 * 7 days: sent + pending recipient rows), and the same user already in this broadcast. Reads across tenants on the
 * platform connection (`// cross-tenant: platform SMS broadcast audience`).
 */
final class BroadcastAudience
{
    public const SKIP_ORDER = ['suspended', 'no_verified_phone', 'opted_out', 'weekly_cap', 'duplicate'];

    /** @return array<string, mixed> validation rules for `audience` */
    public static function rules(string $prefix = 'audience', bool $required = true): array
    {
        return [
            $prefix => [$required ? 'required' : 'sometimes', 'array'],
            "{$prefix}.kind" => [$required ? 'required' : "required_with:{$prefix}", Rule::in(['all', 'plan', 'status', 'trial_ending'])],
            "{$prefix}.plans" => ["required_if:{$prefix}.kind,plan", 'array', 'min:1', 'max:20'],
            "{$prefix}.plans.*" => ['string', 'max:32', 'distinct'],
            "{$prefix}.statuses" => ["required_if:{$prefix}.kind,status", 'array', 'min:1'],
            "{$prefix}.statuses.*" => ['distinct', Rule::in(Subscription::STATUSES)],
        ];
    }

    /** @param array<string, mixed> $audience @return array{kind: string, plans?: list<string>, statuses?: list<string>} */
    public static function normalise(array $audience): array
    {
        $kind = (string) ($audience['kind'] ?? 'all');

        return match ($kind) {
            'plan' => ['kind' => 'plan', 'plans' => array_values(array_map('strval', (array) ($audience['plans'] ?? [])))],
            'status' => ['kind' => 'status', 'statuses' => array_values(array_map('strval', (array) ($audience['statuses'] ?? [])))],
            'trial_ending' => ['kind' => 'trial_ending'],
            'all' => ['kind' => 'all'],
            default => throw ValidationException::withMessages(['audience.kind' => ['Pick an audience.']]),
        };
    }

    /**
     * Every tenant with its owner, latest subscription and SMS language (cross-tenant: platform SMS broadcast audience).
     *
     * @return list<array{tenant_id: string, suspended: bool, plan: string|null, plan_name: string|null, status: string|null, trial_ends_at: string|null, user_id: string|null, name: string, msisdn: string|null, opted_out: bool, language: string}>
     */
    public static function tenants(): array
    {
        $db = PlatformDb::connection(); // cross-tenant: platform SMS broadcast audience
        $owners = $db->table('tenant_users')->where('role', TenantUser::ROLE_OWNER)->orderBy('created_at')->get(['tenant_id', 'user_id'])
            ->unique('tenant_id')->keyBy('tenant_id');
        $subs = $db->table('subscriptions as s')->leftJoin('plans as p', 'p.id', '=', 's.plan_id')
            ->orderBy('s.created_at')->get(['s.tenant_id', 's.status', 's.trial_ends_at', 'p.code', 'p.name'])->keyBy('tenant_id'); // latest wins
        $users = $db->table('users')->whereIn('id', $owners->pluck('user_id')->all())
            ->get(['id', 'name', 'phone', 'phone_verified_at', 'platform_promo_sms_opted_out_at'])->keyBy('id');
        $languages = $db->table('store_settings as ss')->join('stores as st', 'st.id', '=', 'ss.store_id')->pluck('ss.sms_language', 'st.tenant_id');
        $out = [];
        foreach ($db->table('tenants')->orderBy('created_at')->orderBy('id')->get(['id', 'status']) as $t) {
            $owner = $owners->get($t->id);
            $user = $owner !== null ? $users->get($owner->user_id) : null;
            $sub = $subs->get($t->id);
            $out[] = [
                'tenant_id' => (string) $t->id,
                'suspended' => $t->status === Tenant::STATUS_SUSPENDED,
                'plan' => $sub->code ?? null,
                'plan_name' => $sub->name ?? null,
                'status' => $sub->status ?? null,
                'trial_ends_at' => $sub->trial_ends_at ?? null,
                'user_id' => $user !== null ? (string) $user->id : null,
                'name' => (string) ($user->name ?? ''),
                'msisdn' => $user !== null && $user->phone_verified_at !== null ? Phone::bdMsisdn($user->phone) : null,
                'opted_out' => $user !== null && $user->platform_promo_sms_opted_out_at !== null,
                'language' => ($languages[$t->id] ?? 'bn') === 'en' ? 'en' : 'bn',
            ];
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $audience  normalised
     * @param  list<array<string, mixed>>|null  $tenants
     * @return list<array<string, mixed>> the tenants in the audience
     */
    public static function members(array $audience, ?array $tenants = null): array
    {
        $tenants ??= self::tenants();
        $until = now()->addDays(7);

        return array_values(array_filter($tenants, fn (array $t) => match ($audience['kind']) {
            'plan' => in_array($t['plan'], (array) $audience['plans'], true),
            'status' => in_array($t['status'], (array) $audience['statuses'], true),
            'trial_ending' => $t['status'] === Subscription::TRIALING && $t['trial_ends_at'] !== null
                && now()->lte($ends = Carbon::parse($t['trial_ends_at'])) && $ends->lte($until),
            default => true,
        }));
    }

    /** Tenants at the weekly cap (sent + pending recipient rows of the last 7 days), optionally excluding one broadcast. @return array<string, int> */
    public static function capCounts(?string $exceptBroadcast = null): array
    {
        return PlatformDb::connection()->table('platform_sms_broadcast_recipients') // cross-tenant: weekly cap
            ->whereIn('status', [PlatformSmsBroadcastRecipient::SENT, PlatformSmsBroadcastRecipient::PENDING])
            ->where('created_at', '>=', now()->subDays(7))
            ->when($exceptBroadcast !== null, fn ($q) => $q->where('broadcast_id', '<>', $exceptBroadcast))
            ->selectRaw('tenant_id, count(*) as c')->groupBy('tenant_id')->pluck('c', 'tenant_id')->map(fn ($c) => (int) $c)->all();
    }

    /**
     * The skip reason of one member (null = send), in SKIP_ORDER; `$seenUsers` tracks duplicates.
     *
     * @param  array<string, mixed>  $t
     * @param  array<string, int>  $cap
     * @param  array<string, bool>  $seenUsers
     */
    public static function skipReason(array $t, array $cap, array &$seenUsers): ?string
    {
        if ($t['suspended']) {
            return 'suspended';
        }
        if ($t['msisdn'] === null) {
            return 'no_verified_phone';
        }
        if ($t['opted_out']) {
            return 'opted_out';
        }
        if (($cap[$t['tenant_id']] ?? 0) >= (int) config('sms.platform.weekly_cap', 2)) {
            return 'weekly_cap';
        }
        if (isset($seenUsers[$t['user_id']])) {
            return 'duplicate';
        }
        $seenUsers[$t['user_id']] = true;

        return null;
    }

    /** `GET /admin/sms/broadcasts/audiences` (not suspended). @return array<string, mixed> PlatformSmsAudienceCounts */
    public static function counts(): array
    {
        $tenants = array_values(array_filter(self::tenants(), fn (array $t) => ! $t['suspended']));
        $plans = PlatformDb::connection()->table('plans')->where('is_active', true)->orderBy('sort')->get(['code', 'name']);
        $statuses = array_fill_keys(Subscription::STATUSES, 0);
        foreach ($tenants as $t) {
            if ($t['status'] !== null && isset($statuses[$t['status']])) {
                $statuses[$t['status']]++;
            }
        }

        return [
            'all' => count($tenants),
            'plans' => $plans->map(fn ($p) => ['code' => (string) $p->code, 'name' => (string) $p->name,
                'count' => count(array_filter($tenants, fn ($t) => $t['plan'] === $p->code))])->values()->all(),
            'statuses' => $statuses,
            'trial_ending' => count(self::members(['kind' => 'trial_ending'], $tenants)),
        ];
    }
}
