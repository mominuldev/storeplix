<?php

namespace App\Domain\Audit\Http\Controllers;

use App\Domain\Audit\Http\Requests\ListAuditLogsRequest;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
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
    public const PLATFORM_ACTOR = 'platform_user';

    public const PLATFORM_ACTOR_NAME = 'Store Plix support';

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
            // S81: staff ids are never exposed, so they can't be filtered on either.
            $query->where('actor_id', strtolower($filter['actor_id']))->where('actor_type', '!=', 'platform_user');
        }
        if (isset($filter['actor_type'])) {
            $query->where('actor_type', $filter['actor_type']);
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
        // PHASE-8-4: API key actors are named "API: <key name>" (keys are never deleted; revoked ones keep their name).
        $keyIds = $page->getCollection()->where('actor_type', 'api_key')->pluck('actor_id')->filter()->unique();
        if ($keyIds->isNotEmpty()) {
            $actorNames = $actorNames->union(ApiKey::query()->whereIn('id', $keyIds)->pluck('name', 'id')->map(fn ($n) => 'API: '.$n));
        }

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (AuditLog $log) => self::row($log, $actorNames->all()))->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ],
        ]);
    }

    /**
     * PHASE-8-1 P8-8 / S81: a platform actor is shown as "Store Plix support" — never the staff member's id, name,
     * email, IP, user agent or platform role.
     *
     * @param  array<string, string>  $actorNames
     * @return array<string, mixed>
     */
    private static function row(AuditLog $log, array $actorNames): array
    {
        $platform = $log->actor_type === self::PLATFORM_ACTOR;
        $meta = $log->meta ?? [];
        if ($platform) {
            unset($meta['platform_role']);
        }

        return [
            'id' => $log->id,
            'action' => $log->action,
            'actor' => match (true) {
                $log->actor_type === null => null,
                $platform => ['type' => self::PLATFORM_ACTOR, 'id' => null, 'name' => self::PLATFORM_ACTOR_NAME],
                default => [
                    'type' => $log->actor_type,
                    'id' => $log->actor_id,
                    'name' => $log->actor_id ? ($actorNames[$log->actor_id] ?? null) : null,
                ],
            },
            'subject' => $log->subject_type && $log->subject_id ? ['type' => $log->subject_type, 'id' => $log->subject_id] : null,
            'meta' => (object) $meta,
            'ip' => $platform ? null : $log->ip,
            'user_agent' => $platform ? null : $log->user_agent,
            'created_at' => $log->created_at?->toIso8601ZuluString(),
        ];
    }
}
