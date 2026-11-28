<?php

declare(strict_types=1);

namespace App\Domain\Support\Admin;

use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Help\HelpPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketMessage;
use App\Domain\Support\SupportNotifier;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Collection;

/**
 * The cross-tenant support queue (PHASE-8-9C §9, S256). Every read here runs on the platform connection (`pgsql_admin`
 * with RLS on) — `// cross-tenant: support queue`. Per-ticket actions resolve the ticket here, then run inside
 * TenantContext::run($ticket->tenant_id) in the controller.
 */
final class SupportQueue
{
    public const SORTS = ['waiting', 'newest', 'updated', 'priority'];

    /** @return Builder<SupportTicket> */
    public static function query(): Builder
    {
        return SupportTicket::withoutTenancy(); // cross-tenant: support queue
    }

    /** cross-tenant: support queue — ticket id → row (any tenant), else 404. */
    public static function locate(string $id): SupportTicket
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? self::query()->whereKey(strtolower($id))->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /**
     * @param  array<string, mixed>  $filter  validated `filter`
     * @return LengthAwarePaginator<int, SupportTicket>
     */
    public function page(array $filter, string $sort, int $perPage, User $staff): LengthAwarePaginator
    {
        $query = self::query();
        $statuses = self::list($filter['status'] ?? null) ?: [SupportTicket::OPEN, SupportTicket::AWAITING_SUPPORT];
        $query->whereIn('status', $statuses);
        if (is_string($a = $filter['assignee'] ?? null) && $a !== '') {
            match ($a) {
                'me' => $query->where('assignee_id', $staff->id),
                'unassigned' => $query->whereNull('assignee_id'),
                default => $query->where('assignee_id', strtolower($a)),
            };
        }
        if (($p = self::list($filter['priority'] ?? null)) !== []) {
            $query->whereIn('priority', $p);
        }
        if (($c = self::list($filter['category'] ?? null)) !== []) {
            $query->whereIn('category', $c);
        }
        if (is_string($q = $filter['q'] ?? null) && mb_strlen(trim($q)) >= 2) {
            $this->search($query, trim($q));
        }
        match ($sort) {
            'newest' => $query->orderByDesc('created_at'),
            'updated' => $query->orderByDesc('last_message_at'),
            'priority' => $query->orderByRaw("CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END")
                ->orderByRaw('CASE WHEN waiting_since IS NULL THEN 1 ELSE 0 END')->orderBy('waiting_since'),
            default => $query->orderByRaw('CASE WHEN waiting_since IS NULL THEN 1 ELSE 0 END')->orderBy('waiting_since')->orderBy('created_at'),
        };

        return $query->orderBy('id')->paginate($perPage);
    }

    /** @param Builder<SupportTicket> $query */
    private function search(Builder $query, string $q): void
    {
        $db = PlatformDb::connection(); // cross-tenant: support queue search
        $like = '%'.addcslashes(mb_strtolower($q), '%_\\').'%';
        $tenantIds = $db->table('stores')->whereRaw("lower(name) LIKE ? ESCAPE '\\'", [$like])->pluck('tenant_id')
            ->merge($db->table('tenant_users as tu')->join('users as u', 'u.id', '=', 'tu.user_id')->where('tu.role', 'owner')
                ->whereRaw("lower(u.email) LIKE ? ESCAPE '\\'", [$like])->pluck('tu.tenant_id'))
            ->unique()->values()->all();
        $query->where(function (Builder $w) use ($q, $like, $tenantIds) {
            $w->whereRaw("lower(subject) LIKE ? ESCAPE '\\'", [$like]);
            if (preg_match('/^(?:t-?)?(\d{1,12})$/i', $q, $m) === 1) {
                $w->orWhere('number', (int) $m[1]);
            }
            if ($tenantIds !== []) {
                $w->orWhereIn('tenant_id', $tenantIds);
            }
        });
    }

    /** @return array<string, int> counts per status + mine + unassigned (active = not resolved / closed) */
    public function counts(User $staff): array
    {
        $by = self::query()->groupBy('status')->selectRaw('status, count(*) as c')->pluck('c', 'status');
        $out = [];
        foreach (SupportTicket::STATUSES as $s) {
            $out[$s] = (int) ($by[$s] ?? 0);
        }
        $active = [SupportTicket::OPEN, SupportTicket::AWAITING_MERCHANT, SupportTicket::AWAITING_SUPPORT];
        $out['mine'] = self::query()->whereIn('status', $active)->where('assignee_id', $staff->id)->count();
        $out['unassigned'] = self::query()->whereIn('status', $active)->whereNull('assignee_id')->count();

        return $out;
    }

    /** @return array{median_first_reply_seconds_7d: int|null, csat_average_30d: float|null, csat_count_30d: int} */
    public function stats(): array
    {
        $seconds = self::query()->where('created_at', '>=', now()->subDays(7))->whereNotNull('first_staff_reply_at')
            ->get(['created_at', 'first_staff_reply_at'])->map(fn (SupportTicket $t) => max(0, (int) $t->created_at->diffInSeconds($t->first_staff_reply_at)))
            ->sort()->values()->all();
        $median = null;
        if ($seconds !== []) {
            $n = count($seconds);
            $median = $n % 2 === 1 ? $seconds[intdiv($n, 2)] : (int) round(($seconds[$n / 2 - 1] + $seconds[$n / 2]) / 2);
        }
        $rated = self::query()->whereNotNull('csat_rating')->where('csat_rated_at', '>=', now()->subDays(30));
        $count = (clone $rated)->count();

        return [
            'median_first_reply_seconds_7d' => $median,
            'csat_average_30d' => $count === 0 ? null : round((float) (clone $rated)->avg('csat_rating'), 1),
            'csat_count_30d' => $count,
        ];
    }

    /**
     * AdminSupportShop per tenant (cross-tenant: support queue shop context).
     *
     * @param  list<string>  $tenantIds
     * @return array<string, array<string, mixed>>
     */
    public static function shops(array $tenantIds): array
    {
        $tenantIds = array_values(array_unique(array_filter($tenantIds)));
        if ($tenantIds === []) {
            return [];
        }
        $db = PlatformDb::connection(); // cross-tenant: support queue shop context
        $stores = $db->table('stores')->whereIn('tenant_id', $tenantIds)->get(['id', 'tenant_id', 'name'])->keyBy('tenant_id');
        $domains = $db->table('store_domains')->whereIn('tenant_id', $tenantIds)->where('is_primary', true)->pluck('hostname', 'tenant_id');
        $plans = $db->table('subscriptions as s')->join('plans as p', 'p.id', '=', 's.plan_id')->whereIn('s.tenant_id', $tenantIds)
            ->orderBy('s.created_at')->pluck('p.code', 's.tenant_id');
        $out = [];
        foreach ($db->table('tenants')->whereIn('id', $tenantIds)->get(['id', 'name', 'status']) as $t) {
            $store = $stores->get($t->id);
            $out[(string) $t->id] = [
                'tenant_id' => (string) $t->id,
                'tenant_name' => (string) $t->name,
                'store_name' => $store?->name !== null ? (string) $store->name : null,
                'domain' => isset($domains[$t->id]) ? (string) $domains[$t->id] : null,
                'plan' => isset($plans[$t->id]) ? (string) $plans[$t->id] : null,
                'tenant_status' => (string) $t->status,
            ];
        }

        return $out;
    }

    /**
     * @param  list<SupportTicket>  $tickets
     * @return list<array<string, mixed>> AdminSupportTicketSummary rows
     */
    public static function summaries(array $tickets): array
    {
        if ($tickets === []) {
            return [];
        }
        $ids = array_map(fn (SupportTicket $t) => $t->id, $tickets);
        $shops = self::shops(array_map(fn (SupportTicket $t) => $t->tenant_id, $tickets));
        $last = [];
        foreach (SupportTicketMessage::withoutTenancy()->whereIn('ticket_id', $ids) // cross-tenant: support queue
            ->whereIn('kind', [SupportTicketMessage::MERCHANT, SupportTicketMessage::STAFF])
            ->orderBy('created_at')->orderBy('id')->get(['ticket_id', 'kind', 'author_user_id', 'created_at']) as $m) {
            $last[$m->ticket_id] = $m;
        }
        $users = User::query()->whereIn('id', array_values(array_unique(array_filter([
            ...array_map(fn (SupportTicket $t) => $t->requester_id, $tickets),
            ...array_map(fn (SupportTicket $t) => $t->assignee_id, $tickets),
            ...array_map(fn ($m) => $m->author_user_id, array_values($last)),
        ]))))->get(['id', 'name', 'email'])->keyBy('id');

        return array_map(fn (SupportTicket $t) => self::summary($t, $shops, $last[$t->id] ?? null, $users), $tickets);
    }

    /**
     * @param  array<string, array<string, mixed>>  $shops
     * @param  Collection<string, User>  $users
     * @return array<string, mixed>
     */
    public static function summary(SupportTicket $t, array $shops, ?SupportTicketMessage $last, $users): array
    {
        $author = $last?->author_user_id === null ? null : $users->get($last->author_user_id);

        return [
            'id' => $t->id,
            'number' => $t->number,
            'reference' => $t->reference(),
            'subject' => $t->subject,
            'category' => $t->category,
            'priority' => $t->priority,
            'status' => $t->status,
            'shop' => $shops[$t->tenant_id] ?? ['tenant_id' => $t->tenant_id, 'tenant_name' => '', 'store_name' => null, 'domain' => null, 'plan' => null, 'tenant_status' => ''],
            'requester' => UserRef::of($t->requester_id === null ? null : $users->get($t->requester_id)),
            'assignee' => UserRef::of($t->assignee_id === null ? null : $users->get($t->assignee_id)),
            'related_order' => $t->order_number === null ? null : ['id' => $t->order_id, 'number' => $t->order_number],
            'waiting_since' => HelpPresenter::ts($t->waiting_since),
            'first_reply_seconds' => $t->first_staff_reply_at === null ? null : max(0, (int) $t->created_at->diffInSeconds($t->first_staff_reply_at)),
            'last_message_at' => HelpPresenter::ts($t->last_message_at),
            'last_reply' => $last === null ? null : [
                'author_name' => (string) ($author->name ?? ($last->kind === SupportTicketMessage::STAFF ? 'Store Plix' : 'Former member')),
                'is_staff' => $last->kind === SupportTicketMessage::STAFF,
                'at' => HelpPresenter::ts($last->created_at),
            ],
            'messages_count' => $t->messages_count,
            'created_at' => HelpPresenter::ts($t->created_at),
        ];
    }

    /** @return list<array<string, mixed>> AdminSupportAssignee[] (active staff with manage_support, you first) */
    public function assignees(User $staff): array
    {
        $roles = array_values(array_map(fn (PlatformRole $r) => $r->value, array_filter(PlatformRole::cases(), fn (PlatformRole $r) => $r->can(PlatformPermission::ManageSupport))));
        $users = User::query()->whereIn('platform_role', $roles)->whereNull('platform_disabled_at')->orderBy('name')->get();
        $open = self::query()->whereIn('status', [SupportTicket::OPEN, SupportTicket::AWAITING_MERCHANT, SupportTicket::AWAITING_SUPPORT])
            ->whereNotNull('assignee_id')->groupBy('assignee_id')->selectRaw('assignee_id, count(*) as c')->pluck('c', 'assignee_id');
        $rows = $users->filter(fn (User $u) => SupportNotifier::activeSupportStaff($u))->map(fn (User $u) => [
            'user' => UserRef::of($u),
            'platform_role' => (string) $u->platform_role,
            'open_count' => (int) ($open[$u->id] ?? 0),
            'is_you' => $u->id === $staff->id,
        ])->values()->all();
        usort($rows, fn ($a, $b) => [$b['is_you'] ? 1 : 0] <=> [$a['is_you'] ? 1 : 0]);

        return $rows;
    }

    /** @return list<string> */
    private static function list(mixed $value): array
    {
        if (is_array($value)) {
            $value = implode(',', array_map('strval', $value));
        }

        return is_string($value) && trim($value) !== '' ? array_values(array_unique(array_filter(array_map('trim', explode(',', $value))))) : [];
    }
}
