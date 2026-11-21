<?php

namespace App\Domain\Audit\Http\Controllers;

use App\Domain\Audit\Http\Requests\ListAuditLogsRequest;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;

/**
 * GET /audit-logs — only this tenant's rows (account-level rows with tenant_id null are never listed).
 * audit_logs is not globally scoped (tenant_id nullable), so the filter here is explicit.
 */
class AuditLogController
{
    public function __invoke(ListAuditLogsRequest $request, TenantContext $context): JsonResponse
    {
        $filter = $request->validated('filter', []);
        $perPage = (int) $request->validated('per_page', 25);

        $query = AuditLog::query()->where('tenant_id', $context->requireId());

        if (isset($filter['action'])) {
            $actions = array_filter(array_map('trim', explode(',', $filter['action'])));
            $query->where(function ($q) use ($actions) {
                foreach ($actions as $action) {
                    str_ends_with($action, '*')
                        ? $q->orWhere('action', 'like', rtrim($action, '*').'%') // input limited to [a-z0-9_.*,]
                        : $q->orWhere('action', $action);
                }
            });
        }
        if (isset($filter['actor_id'])) {
            $query->where('actor_id', strtolower($filter['actor_id']));
        }
        if (isset($filter['subject_type'])) {
            $query->where('subject_type', $filter['subject_type']);
        }
        if (isset($filter['subject_id'])) {
            $query->where('subject_id', strtolower($filter['subject_id']));
        }
        if (isset($filter['created_at']['gte'])) {
            $query->where('created_at', '>=', Carbon::parse($filter['created_at']['gte'])->utc());
        }
        if (isset($filter['created_at']['lte'])) {
            $query->where('created_at', '<=', Carbon::parse($filter['created_at']['lte'])->utc());
        }

        $page = $query->orderByDesc('created_at')->orderByDesc('id')->paginate($perPage);

        $actorNames = User::query()
            ->whereIn('id', $page->getCollection()->where('actor_type', 'user')->pluck('actor_id')->filter()->unique())
            ->pluck('name', 'id');

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (AuditLog $log) => [
                'id' => $log->id,
                'action' => $log->action,
                'actor' => $log->actor_type === null ? null : [
                    'type' => $log->actor_type,
                    'id' => $log->actor_id,
                    'name' => $log->actor_id ? ($actorNames[$log->actor_id] ?? null) : null,
                ],
                'subject' => $log->subject_type && $log->subject_id ? ['type' => $log->subject_type, 'id' => $log->subject_id] : null,
                'meta' => (object) ($log->meta ?? []),
                'ip' => $log->ip,
                'user_agent' => $log->user_agent,
                'created_at' => $log->created_at?->toIso8601ZuluString(),
            ])->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ],
        ]);
    }
}
