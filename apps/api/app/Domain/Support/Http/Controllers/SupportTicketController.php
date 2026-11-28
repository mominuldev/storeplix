<?php

declare(strict_types=1);

namespace App\Domain\Support\Http\Controllers;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Support\Http\Requests\CreateSupportTicketRequest;
use App\Domain\Support\Http\Requests\ReplySupportTicketRequest;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\SupportPresenter;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Merchant support tickets (PHASE-8-9C §8.2; `perm:support.manage`). Tenant-level: tickets of another tenant → 404
 * (TenantScope + RLS). Every holder sees and replies to every ticket of the tenant (P89C-13).
 */
class SupportTicketController
{
    public function __construct(
        private readonly SupportTicketService $tickets,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'filter.tab' => ['sometimes', 'nullable', Rule::in(['all', 'open', 'waiting_on_you', 'solved'])],
            'filter.q' => ['sometimes', 'nullable', 'string', 'max:150'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        $tab = (string) ($filter['tab'] ?? 'all');
        $q = is_string($filter['q'] ?? null) ? trim((string) $filter['q']) : '';

        $base = function () use ($q): Builder {
            $query = SupportTicket::query();
            if ($q !== '') {
                if (preg_match('/^(?:t-?)?(\d{1,12})$/i', $q, $m) === 1) {
                    $query->where(fn (Builder $w) => $w->where('number', (int) $m[1])->orWhereRaw("lower(subject) LIKE ? ESCAPE '\\'", ['%'.addcslashes(mb_strtolower($q), '%_\\').'%']));
                } else {
                    $query->whereRaw("lower(subject) LIKE ? ESCAPE '\\'", ['%'.addcslashes(mb_strtolower($q), '%_\\').'%']);
                }
            }

            return $query;
        };
        $page = $base()->when($tab !== 'all', fn (Builder $b) => $b->whereIn('status', SupportTicket::TABS[$tab]))
            ->orderByDesc('last_message_at')->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 20));

        $counts = ['all' => $base()->count()];
        foreach (SupportTicket::TABS as $name => $statuses) {
            $counts[$name] = $base()->whereIn('status', $statuses)->count();
        }

        return new JsonResponse(['data' => SupportPresenter::summaries($page->getCollection()->all()), 'meta' => [
            'current_page' => $page->currentPage(), 'per_page' => $page->perPage(), 'total' => $page->total(), 'last_page' => $page->lastPage(),
            'counts' => $counts,
            'stats' => $this->stats(),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function store(CreateSupportTicketRequest $request): JsonResponse
    {
        /** @var array{category: string, subject: string, description: string, priority?: string|null, order_id?: string|null, attachment_ids?: list<string>, client_id: string} $input */
        $input = $request->validated();
        [$ticket, $created] = $this->tickets->create(self::user($request), $input);

        return self::json(SupportPresenter::ticket($ticket, $this->context->allows(Permission::OrdersView), true), $created ? 201 : 200);
    }

    public function show(string $ticket): JsonResponse
    {
        return self::json(SupportPresenter::ticket(self::find($ticket), $this->context->allows(Permission::OrdersView), true));
    }

    public function messages(string $ticket): JsonResponse
    {
        return self::json(SupportPresenter::messages(self::find($ticket)));
    }

    public function reply(ReplySupportTicketRequest $request, string $ticket): JsonResponse
    {
        /** @var array{body: string, attachment_ids?: list<string>, client_id: string} $input */
        $input = $request->validated();
        $row = self::find($ticket);
        [$message, $created] = $this->tickets->reply($row->id, self::user($request), $input);
        $one = collect(SupportPresenter::messages($row->fresh() ?? $row))->firstWhere('id', $message->id);

        return self::json($one, $created ? 201 : 200);
    }

    public function resolve(Request $request, string $ticket): JsonResponse
    {
        $row = $this->tickets->resolveByMerchant(self::find($ticket)->id, self::user($request));

        return self::json(SupportPresenter::ticket($row, $this->context->allows(Permission::OrdersView), true));
    }

    public function rate(Request $request, string $ticket): JsonResponse
    {
        $input = $request->validate([
            'rating' => ['required', 'integer', 'between:1,5'],
            'comment' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);
        $row = $this->tickets->rate(self::find($ticket)->id, self::user($request), (int) $input['rating'], $input['comment'] ?? null);

        return self::json(SupportPresenter::ticket($row, $this->context->allows(Permission::OrdersView), true));
    }

    /** @return array<string, mixed> */
    private function stats(): array
    {
        $monthStart = now()->setTimezone('Asia/Dhaka')->startOfMonth()->utc();
        $first = SupportTicket::query()->where('created_at', '>=', now()->subDays(90))->whereNotNull('first_staff_reply_at')
            ->get(['created_at', 'first_staff_reply_at']);
        $rated = SupportTicket::query()->whereNotNull('csat_rating');

        return [
            'open' => SupportTicket::query()->whereIn('status', SupportTicket::TABS['open'])->count(),
            'waiting_on_you' => SupportTicket::query()->whereIn('status', SupportTicket::TABS['waiting_on_you'])->count(),
            'solved_this_month' => SupportTicket::query()->whereIn('status', SupportTicket::TABS['solved'])->where('resolved_at', '>=', $monthStart)->count(),
            'avg_first_reply_seconds' => $first->isEmpty() ? null
                : (int) round($first->avg(fn (SupportTicket $t) => max(0, (int) $t->created_at->diffInSeconds($t->first_staff_reply_at)))),
            'csat_average' => ($c = (clone $rated)->count()) === 0 ? null : round((float) (clone $rated)->avg('csat_rating'), 1),
            'csat_count' => $c,
        ];
    }

    public static function find(string $id): SupportTicket
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? SupportTicket::query()->whereKey(strtolower($id))->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private static function user(Request $request): User
    {
        $user = $request->user();

        return $user instanceof User ? $user : throw new ApiException(401, 'unauthenticated', 'Unauthenticated.');
    }

    private static function json(mixed $data, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => $data], $status, ['Cache-Control' => 'private, no-store']);
    }
}
