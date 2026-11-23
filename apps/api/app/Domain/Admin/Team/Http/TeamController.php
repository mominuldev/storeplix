<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Authorization\PlatformRoleMatrix;
use App\Domain\Admin\Team\Http\Requests\ChangeStaffRoleRequest;
use App\Domain\Admin\Team\Http\Requests\InviteStaffRequest;
use App\Domain\Admin\Team\Http\Requests\ListTeamRequest;
use App\Domain\Admin\Team\Http\Requests\StaffReasonRequest;
use App\Domain\Admin\Team\Http\Resources\PlatformInvitationResource;
use App\Domain\Admin\Team\Http\Resources\PlatformStaffResource;
use App\Domain\Admin\Team\Models\PlatformInvitation;
use App\Domain\Admin\Team\TeamManager;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-1 §6.5 team rows (P8-16). `users` and `platform_invitations` are platform tables (no tenant data, no RLS),
 * so these reads stay on the default connection.
 */
class TeamController
{
    public function __construct(private readonly TeamManager $team) {}

    public function index(ListTeamRequest $request): JsonResponse
    {
        $filter = (array) $request->validated('filter', []);
        $status = (string) ($filter['status'] ?? 'all');
        $role = isset($filter['role']) ? (string) $filter['role'] : null;
        $q = isset($filter['q']) ? strtolower(trim((string) $filter['q'])) : '';

        $users = User::query()->whereNotNull('platform_role');
        $invitations = PlatformInvitation::query()->usable();
        if ($role !== null) {
            $users->where('platform_role', $role);
            $invitations->where('role', $role);
        }
        if ($q !== '') {
            $like = '%'.addcslashes($q, '%_\\').'%';
            $users->where(fn (Builder $w) => $w->whereRaw('lower(name) like ?', [$like])->orWhereRaw('lower(email) like ?', [$like]));
            $invitations->whereRaw('lower(email) like ?', [$like]);
        }

        $counts = [
            'active' => (clone $users)->whereNull('platform_disabled_at')->count(),
            'invited' => (clone $invitations)->count(),
            'disabled' => (clone $users)->whereNotNull('platform_disabled_at')->count(),
        ];
        $counts = ['all' => array_sum($counts)] + $counts;

        $rows = collect();
        if (in_array($status, ['all', 'active', 'disabled'], true)) {
            $query = (clone $users)->orderBy('name')->orderBy('id');
            if ($status === 'active') {
                $query->whereNull('platform_disabled_at');
            } elseif ($status === 'disabled') {
                $query->whereNotNull('platform_disabled_at');
            }
            $rows = $rows->concat($query->get());
        }
        if (in_array($status, ['all', 'invited'], true)) {
            $rows = $rows->concat($invitations->orderByDesc('created_at')->get());
        }

        return new JsonResponse([
            'data' => PlatformStaffResource::collection($rows)->resolve($request),
            'meta' => [
                'counts' => $counts,
                'matrix' => PlatformRoleMatrix::toArray(),
                'security' => [
                    'totp_required' => true,
                    'ip_allowlist_enabled' => (array) config('admin.ip_allowlist', []) !== [],
                    'session_idle_minutes' => (int) config('admin.session_idle_minutes', 30),
                    'impersonation_minutes' => (int) config('admin.impersonation_minutes', 15),
                ],
            ],
        ]);
    }

    public function invite(InviteStaffRequest $request): JsonResponse
    {
        [$invitation] = $this->team->invite(self::actor($request), (string) $request->validated('email'), PlatformRole::from((string) $request->validated('role')));

        return (new PlatformInvitationResource($invitation))->response()->setStatusCode(201);
    }

    public function revokeInvitation(Request $request, string $invitation): Response
    {
        $row = PlatformInvitation::query()->open()->whereKey(strtolower($invitation))->first()
            ?? throw new ApiException(404, 'not_found', 'Invitation not found.');
        $this->team->revokeInvitation(self::actor($request), $row);

        return response()->noContent();
    }

    public function updateRole(ChangeStaffRoleRequest $request, string $user): JsonResponse
    {
        return self::staff($this->team->changeRole(self::actor($request), self::member($user), PlatformRole::from((string) $request->validated('role')), (string) $request->validated('reason')));
    }

    public function disable(StaffReasonRequest $request, string $user): JsonResponse
    {
        return self::staff($this->team->disable(self::actor($request), self::member($user), (string) $request->validated('reason')));
    }

    public function enable(StaffReasonRequest $request, string $user): JsonResponse
    {
        return self::staff($this->team->enable(self::actor($request), self::member($user), (string) $request->validated('reason')));
    }

    public function resetTotp(StaffReasonRequest $request, string $user): JsonResponse
    {
        return self::staff($this->team->resetTotp(self::actor($request), self::member($user), (string) $request->validated('reason')));
    }

    private static function actor(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }

    /** A platform staff user (any status); anyone else → 404. */
    private static function member(string $id): User
    {
        return User::query()->whereNotNull('platform_role')->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Staff member not found.');
    }

    private static function staff(User $user): JsonResponse
    {
        return new JsonResponse(['data' => (new PlatformStaffResource($user->refresh()))->resolve()]);
    }
}
