<?php

declare(strict_types=1);

namespace App\Domain\Admin\Audit\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-1 §6.5 platform audit log (`39:16118`) and the merchant-detail Audit tab, on the admin connection (P8-6),
 * cursor pagination newest first. Staff see actor names and e-mails (the merchant log hides them, S81).
 */
class AdminAuditLogController
{
    public function index(Request $request): JsonResponse
    {
        return $this->list($request, null);
    }

    public function forTenant(Request $request, string $tenant): JsonResponse
    {
        return $this->list($request, (string) TenantDirectory::find($tenant)->id);
    }

    private function list(Request $request, ?string $tenantId): JsonResponse
    {
        $ulid = 'regex:/^[0-9A-Za-z]{26}$/';
        $input = $request->validate([
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter' => ['sometimes', 'array'],
            'filter.tenant' => ['sometimes', 'string', $ulid],
            'filter.actor' => ['sometimes', 'string', $ulid],
            'filter.actor_type' => ['sometimes', 'string', Rule::in(['user', 'system', 'platform_user'])],
            'filter.action' => ['sometimes', 'string', 'max:64', 'regex:/^[a-z0-9_.]+$/'],
            'filter.from' => ['sometimes', 'date_format:Y-m-d'],
            'filter.to' => ['sometimes', 'date_format:Y-m-d'],
            'filter.impersonation' => ['sometimes', 'boolean'],
        ]);
        $filter = (array) ($input['filter'] ?? []);

        // cross-tenant: admin audit log
        $query = PlatformDb::reroute(AuditLog::query());
        if (($tenantId ??= isset($filter['tenant']) ? strtolower($filter['tenant']) : null) !== null) {
            $query->where('tenant_id', $tenantId);
        }
        if (isset($filter['actor'])) {
            $query->where('actor_id', strtolower($filter['actor']));
        }
        if (isset($filter['actor_type'])) {
            $query->where('actor_type', $filter['actor_type']);
        }
        if (isset($filter['action'])) {
            $query->where('action', 'like', $filter['action'].'%'); // input limited to [a-z0-9_.]
        }
        if (isset($filter['from'])) {
            $query->where('created_at', '>=', Carbon::parse($filter['from'])->startOfDay());
        }
        if (isset($filter['to'])) {
            $query->where('created_at', '<=', Carbon::parse($filter['to'])->endOfDay());
        }
        if (filter_var($filter['impersonation'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
            $query->where(fn ($q) => $q->where('action', 'like', 'admin.impersonation%')->orWhereNotNull('meta->impersonation_id'));
        }

        $page = $query->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate((int) ($input['per_page'] ?? 25), ['*'], 'cursor', $input['cursor'] ?? null);
        $rows = collect($page->items());

        $db = PlatformDb::connection();
        $actors = $db->table('users')->whereIn('id', $rows->pluck('actor_id')->filter()->unique()->values()->all())
            ->get(['id', 'name', 'email'])->keyBy('id');
        $shops = AdminPresenter::shopRefs($rows->pluck('tenant_id')->filter()->map(fn ($id) => (string) $id)->values()->all());

        return AdminPresenter::json([
            'data' => $rows->map(fn (AuditLog $log) => self::row($log, $actors->all(), $shops))->all(),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ]);
    }

    /**
     * @param  array<string, object>  $actors
     * @param  array<string, array{id: string, name: string, slug: string}>  $shops
     * @return array<string, mixed> AdminAuditEntry
     */
    private static function row(AuditLog $log, array $actors, array $shops): array
    {
        $meta = $log->meta ?? [];
        $actor = $log->actor_id !== null ? ($actors[$log->actor_id] ?? null) : null;

        return [
            'id' => $log->id,
            'action' => $log->action,
            'actor' => [
                'type' => $log->actor_type ?? 'system',
                'id' => $log->actor_id,
                'name' => $actor?->name,
                'email' => $actor?->email,
            ],
            'tenant' => $log->tenant_id !== null ? ($shops[$log->tenant_id] ?? ['id' => $log->tenant_id, 'name' => '', 'slug' => '']) : null,
            'subject' => $log->subject_type && $log->subject_id ? ['type' => $log->subject_type, 'id' => $log->subject_id] : null,
            'reason' => is_string($meta['reason'] ?? null) ? $meta['reason'] : null,
            'ip' => $log->ip,
            'user_agent' => $log->user_agent,
            'meta' => $meta === [] ? null : $meta,
            'impersonation_id' => is_string($meta['impersonation_id'] ?? null) ? $meta['impersonation_id'] : null,
            'created_at' => AdminPresenter::ts($log->created_at),
        ];
    }
}
