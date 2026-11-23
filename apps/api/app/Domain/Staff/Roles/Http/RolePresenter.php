<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles\Http;

use App\Domain\Shared\Http\UserRef;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Staff\Roles\RoleService;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;

/**
 * Shapes Role / RoleDetail / RoleMember / PermissionGroup (PHASE-8-3 §6.3, openapi 1.11.0). Built for the CURRENT
 * tenant: members and open invitations are loaded once per request and grouped by role.
 */
final class RolePresenter
{
    /** @var Collection<string, Collection<int, array<string, mixed>>> role id → RoleMember rows (members, then invitations) */
    private Collection $people;

    private bool $feature;

    public function __construct(
        private readonly TenantContext $context,
        private readonly RoleService $roles,
        private readonly ?string $userId,
    ) {
        $members = TenantUser::query()->forTenant($context->requireId())->with('user')->get()
            ->map(fn (TenantUser $m) => [
                'role_id' => $m->role_id,
                'row' => [
                    'id' => $m->id,
                    'kind' => 'member',
                    'user_id' => $m->user_id,
                    'name' => $m->user?->name,
                    'email' => (string) $m->user?->email,
                    'phone' => $m->user?->phone,
                    'status' => 'active',
                    'is_you' => $m->user_id === $userId,
                ],
            ]);
        $invitations = StaffInvitation::query()->open()->get()
            ->map(fn (StaffInvitation $i) => [
                'role_id' => $i->role_id,
                'row' => [
                    'id' => $i->id,
                    'kind' => 'invitation',
                    'user_id' => null,
                    'name' => $i->name,
                    'email' => $i->email,
                    'phone' => null,
                    'status' => $i->isExpired() ? 'expired' : 'invited',
                    'is_you' => false,
                ],
            ]);
        $byName = fn (array $a, array $b) => strcasecmp((string) ($a['row']['name'] ?? $a['row']['email']), (string) ($b['row']['name'] ?? $b['row']['email']));

        $this->people = $members->sort($byName)->concat($invitations->sort($byName)->values())
            ->groupBy('role_id')
            ->map(fn (Collection $rows) => $rows->pluck('row')->values());
        $this->feature = $roles->featureEnabled();
    }

    /** @return list<array<string, mixed>> system roles (owner, admin, staff) then custom roles by name */
    public function list(Collection $roles): array
    {
        return $roles->sort(function (Role $a, Role $b) {
            $pa = $a->systemRole()?->position() ?? 99;
            $pb = $b->systemRole()?->position() ?? 99;

            return $pa <=> $pb ?: strcasecmp($a->name, $b->name);
        })->values()->map(fn (Role $r) => $this->role($r))->all();
    }

    /** @return array<string, mixed> */
    public function role(Role $role): array
    {
        $rows = $this->people->get($role->id, collect());
        $members = $rows->where('kind', 'member');
        $editable = ! $role->is_system && $this->feature
            && $role->id !== $this->context->roleId() && $this->roles->holdsAllOf($role);

        return [
            'id' => $role->id,
            'key' => $role->systemRole()?->value,
            'name' => $role->name,
            'description' => $role->description,
            'is_system' => $role->is_system,
            'permissions' => RolePermissions::for($role)->keys(),
            'members_count' => $members->count(),
            'invitations_count' => $rows->count() - $members->count(),
            'members_preview' => $rows->take(3)->map(fn (array $r) => ['id' => $r['id'], 'name' => (string) ($r['name'] ?? $r['email'])])->values()->all(),
            'editable' => $editable,
            'revision' => $role->revision,
            'created_at' => UserRef::iso($role->created_at),
            'updated_at' => UserRef::iso($role->updated_at),
            'updated_by' => $role->editor !== null ? ['id' => $role->editor->id, 'name' => $role->editor->name] : null,
        ];
    }

    /** @return array<string, mixed> */
    public function detail(Role $role): array
    {
        return $this->role($role) + ['members' => $this->people->get($role->id, collect())->values()->all()];
    }

    /** @return list<array<string, mixed>> */
    public static function catalogue(): array
    {
        $groups = [];
        foreach (Permission::GROUPS as $key => $label) {
            $groups[$key] = ['key' => $key, 'label' => $label, 'permissions' => []];
        }
        foreach (Permission::cases() as $p) {
            $groups[$p->group()]['permissions'][] = [
                'key' => $p->value,
                'label' => $p->label(),
                'description' => $p->description(),
                'requires' => array_map(fn (Permission $r) => $r->value, $p->requires()),
                'sensitive' => $p->sensitive(),
                'grantable' => $p->grantable(),
            ];
        }

        return array_values($groups);
    }

    /** @return array{custom_roles_used: int, custom_roles_limit: int, custom_roles_enabled: bool} */
    public function meta(Collection $roles): array
    {
        return [
            'custom_roles_used' => $roles->where('is_system', false)->count(),
            'custom_roles_limit' => RoleService::MAX_CUSTOM,
            'custom_roles_enabled' => $this->feature,
        ];
    }
}
