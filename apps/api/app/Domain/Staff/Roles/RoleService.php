<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-3 §4 / §6: custom roles and the non-delegation rules.
 *
 * Evaluation order per request (§4): `perm:` → 404 → N4 → N3/N7 → N9 → N1/N2/N5/N6 → validation (422) →
 * N8 / limits / conflicts (409). Controllers call the guards in that order; writes run in a transaction that locks
 * the tenant row (role count, names) or the role row (revision).
 */
class RoleService
{
    public const MAX_CUSTOM = 20;

    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    // ---------------------------------------------------------------- guards (§4)

    /** N4. */
    public function assertNotSystem(Role $role): void
    {
        if ($role->is_system) {
            throw new ApiException(409, 'system_role_locked', 'Built-in roles cannot be changed. Duplicate it to customise.');
        }
    }

    /** N3. */
    public function assertNotOwnRole(Role $role): void
    {
        if ($this->context->roleId() !== null && $role->id === $this->context->roleId()) {
            throw new ApiException(403, 'cannot_edit_own_role', "You can't edit your own role.");
        }
    }

    /** N9 (custom roles need the custom_roles feature, P83-8). */
    public function assertFeature(): void
    {
        FeatureGate::assertAllows($this->tenant(), Feature::CustomRoles);
    }

    public function featureEnabled(): bool
    {
        return FeatureGate::allows($this->tenant(), Feature::CustomRoles);
    }

    /** N1/N2/N5/N6: every permission of $set is held by the actor → else 403 permission_not_held. */
    public function assertHeld(PermissionSet $set): void
    {
        $missing = $set->missingFrom($this->context->permissions());
        if ($missing !== []) {
            throw new ApiException(403, 'permission_not_held', "You can't give or manage permissions you don't have.", [
                'permissions' => array_map(fn (Permission $p) => $p->value, $missing),
            ]);
        }
    }

    /**
     * N2 / N6 on a role by id, fail closed (SEC-L5): a missing role row counts as holding every permission, so only
     * the owner passes. $lock takes the row lock (call inside the transaction that writes).
     */
    public function assertHoldsRole(?string $roleId, bool $lock = false): ?Role
    {
        $role = $roleId === null ? null : Role::query()->whereKey($roleId)->when($lock, fn ($q) => $q->lockForUpdate())->first();
        $this->assertHeld($role !== null ? RolePermissions::for($role) : new PermissionSet(Permission::cases()));

        return $role;
    }

    /** N2 / N6 helper: the actor holds every permission of the role. */
    public function holdsAllOf(Role $role): bool
    {
        return RolePermissions::for($role)->missingFrom($this->context->permissions()) === [];
    }

    /**
     * N5 for an assignment target (invite, member role change, reassign_to): a role of this tenant (else 422), never
     * the owner role (422), custom only with the feature (402), held by the actor (403).
     */
    public function assignable(?string $roleId, string $field = 'role_id'): Role
    {
        $role = $roleId !== null && preg_match('/^[0-9A-Za-z]{26}$/', $roleId) === 1
            ? Role::query()->whereKey(strtolower($roleId))->first()
            : null;
        if ($role === null) {
            throw ValidationException::withMessages([$field => ['The selected role does not exist.']]);
        }
        if ($role->isOwner()) {
            throw ValidationException::withMessages([$field => ['The owner role cannot be assigned.']]);
        }
        if (! $role->is_system) {
            $this->assertFeature();
        }
        $this->assertHeld(RolePermissions::for($role));

        return $role;
    }

    /** Legacy `role` input (admin|staff) → the tenant's system role. */
    public function systemRole(SystemRole $role): Role
    {
        return Role::query()->whereKey(SystemRoles::id($role))->firstOrFail();
    }

    /**
     * N1 pre-check on the raw payload: grantable known keys the actor lacks → 403. Unknown or non-grantable keys are
     * left to validation (422, S99), so they never leak as 403 nor pass.
     */
    public function assertCanGrant(mixed $permissions): void
    {
        if (! is_array($permissions)) {
            return;
        }
        $keys = PermissionSet::fromKeys(array_filter($permissions, 'is_string'));
        $this->assertHeld(new PermissionSet(array_filter($keys->toArray(), fn (Permission $p) => $p->grantable())));
    }

    // ---------------------------------------------------------------- validation

    /** @return array<string, mixed> */
    public function rules(bool $create): array
    {
        return [
            'name' => [$create ? 'required' : 'sometimes', 'string', 'min:1', 'max:'.Role::MAX_NAME, 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'description' => ['sometimes', 'nullable', 'string', 'max:'.Role::MAX_DESCRIPTION, 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u'],
            'permissions' => [$create ? 'present' : 'sometimes', 'array', 'max:'.count(Permission::grantableCases())],
            'permissions.*' => ['string', 'distinct', 'in:'.implode(',', array_map(fn (Permission $p) => $p->value, Permission::grantableCases()))],
        ] + ($create ? [] : ['revision' => ['required', 'integer:strict', 'min:1']]);
    }

    /** P83-11: every prerequisite of a key is in the set. @param list<string> $keys */
    public function assertPrerequisites(array $keys): PermissionSet
    {
        $set = PermissionSet::fromKeys($keys);
        $errors = [];
        foreach ($set->toArray() as $permission) {
            foreach ($permission->requires() as $needed) {
                if (! $set->has($needed)) {
                    $errors[] = "{$permission->value} needs {$needed->value}.";
                }
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages(['permissions' => $errors]);
        }

        return $set;
    }

    /** Unique per tenant, case-insensitive, including the system names. */
    public function assertNameFree(string $name, ?string $exceptId = null): void
    {
        $taken = Role::query()->whereRaw('lower(name) = ?', [mb_strtolower($name)])
            ->when($exceptId !== null, fn ($q) => $q->whereKeyNot($exceptId))->exists();
        if ($taken) {
            throw ValidationException::withMessages(['name' => ['A role with this name already exists.']]);
        }
    }

    // ---------------------------------------------------------------- writes

    /** @param array{name: string, description?: string|null, permissions: list<string>} $input */
    public function create(array $input, PermissionSet $permissions, User $actor): Role
    {
        $name = trim($input['name']);

        $role = $this->unique(fn () => DB::transaction(function () use ($input, $name, $permissions, $actor) {
            Tenant::query()->whereKey($this->context->requireId())->lockForUpdate()->first(['id']);
            $this->assertNameFree($name);
            if (Role::query()->where('is_system', false)->count() >= self::MAX_CUSTOM) {
                throw new ApiException(409, 'role_limit_reached', 'You can have at most '.self::MAX_CUSTOM.' custom roles.');
            }

            $role = Role::query()->create([
                'name' => $name,
                'description' => self::cleanDescription($input['description'] ?? null),
                'is_system' => false,
                'revision' => 1,
                'created_by' => $actor->getKey(),
                'updated_by' => $actor->getKey(),
            ]);
            $this->writePermissions($role, $permissions);

            return $role;
        }));

        $this->audit->log('role.created', $role, ['name' => $role->name, 'permissions' => $permissions->keys()]);

        return $role;
    }

    /** @param array{revision: int, name?: string, description?: string|null, permissions?: list<string>} $input */
    public function update(Role $role, array $input, ?PermissionSet $permissions, User $actor): Role
    {
        $changes = [];

        $role = $this->unique(function () use ($role, $input, $permissions, $actor, &$changes) {
            return DB::transaction(function () use ($role, $input, $permissions, $actor, &$changes) {
                Tenant::query()->whereKey($this->context->requireId())->lockForUpdate()->first(['id']);
                /** @var Role $locked */
                $locked = Role::query()->whereKey($role->id)->lockForUpdate()->firstOrFail();
                // SEC-L3: N2 again on the locked row (the pre-check read it unlocked).
                $this->assertHeld(RolePermissions::for($locked));
                if ($locked->revision !== (int) $input['revision']) {
                    throw new ApiException(409, 'revision_conflict', 'This role was changed by someone else. Reload and try again.');
                }

                if (array_key_exists('name', $input) && ($name = trim((string) $input['name'])) !== $locked->name) {
                    $this->assertNameFree($name, $locked->id);
                    $changes['name'] = ['from' => $locked->name, 'to' => $name];
                    $locked->name = $name;
                }
                if (array_key_exists('description', $input) && ($description = self::cleanDescription($input['description'])) !== $locked->description) {
                    $changes['description'] = ['from' => $locked->description, 'to' => $description];
                    $locked->description = $description;
                }
                if ($permissions !== null) {
                    $current = RolePermissions::for($locked);
                    $added = array_values(array_diff($permissions->keys(), $current->keys()));
                    $removed = array_values(array_diff($current->keys(), $permissions->keys()));
                    if ($added !== [] || $removed !== []) {
                        $changes['permissions'] = ['added' => $added, 'removed' => $removed];
                        $this->writePermissions($locked, $permissions);
                    }
                }

                // Every successful PATCH increments the revision (§6.1); it also keys the permission cache (S97).
                $locked->revision = $locked->revision + 1;
                $locked->updated_by = $actor->getKey();
                $locked->save();

                return $locked;
            });
        });

        if ($changes !== []) {
            $this->audit->log('role.updated', $role, ['changes' => $changes]);
        }

        return $role;
    }

    /**
     * P83-10: members and open invitations move to $target (or 409 role_in_use), then the role is deleted.
     * SEC-L3: the tenant and both role rows are locked first; N2 (role) and N5 (target) are re-checked on the locked
     * rows and `$revision` must still match (409 revision_conflict).
     */
    public function delete(Role $role, ?Role $target, int $revision): void
    {
        $moved = DB::transaction(function () use ($role, &$target, $revision) {
            Tenant::query()->whereKey($this->context->requireId())->lockForUpdate()->first(['id']);
            /** @var Role $locked */
            $locked = Role::query()->whereKey($role->id)->lockForUpdate()->firstOrFail();
            $this->assertHeld(RolePermissions::for($locked));                                   // N2
            if ($target !== null) {
                $target = Role::query()->whereKey($target->id)->lockForUpdate()->first()
                    ?? throw ValidationException::withMessages(['reassign_to' => ['The selected role does not exist.']]);
                $this->assertHeld(RolePermissions::for($target));                               // N5
            }
            if ($locked->revision !== $revision) {
                throw new ApiException(409, 'revision_conflict', 'This role was changed by someone else. Reload and try again.');
            }
            $members = TenantUser::query()->forTenant($locked->tenant_id)->where('role_id', $locked->id)->with('user')->get();
            $open = StaffInvitation::query()->open()->where('role_id', $locked->id)->get();

            if ($target === null && ($members->isNotEmpty() || $open->isNotEmpty())) {
                throw new ApiException(409, 'role_in_use', 'People still have this role. Choose a role to move them to.', [
                    'members' => $members->pluck('id')->values()->all(),
                    'invitations' => $open->pluck('id')->values()->all(),
                ]);
            }

            foreach ($members as $member) {
                $member->update(['role_id' => $target->id]);
                $this->audit->log('staff.role_changed', $member, self::roleChangeMeta($locked, $target));
            }
            if ($target !== null) {
                StaffInvitation::query()->open()->where('role_id', $locked->id)->update(['role_id' => $target->id, 'role' => $target->kind()]);
            }
            // Accepted / revoked invitations keep only a historical role: they follow the target, or the Staff role
            // when nobody needed moving (the FK is ON DELETE RESTRICT).
            $closedTarget = $target ?? $this->systemRole(SystemRole::Staff);
            StaffInvitation::query()->where('role_id', $locked->id)->update(['role_id' => $closedTarget->id, 'role' => $closedTarget->kind()]);

            DB::table('role_permissions')->where('tenant_id', $locked->tenant_id)->where('role_id', $locked->id)->delete();
            $locked->delete();

            return ['members' => $members->count(), 'invitations' => $open->count()];
        });

        $this->audit->log('role.deleted', $role, [
            'name' => $role->name,
            'reassigned_to' => $target !== null ? ['id' => $target->id, 'name' => $target->name] : null,
            'members_moved' => $moved['members'],
            'invitations_moved' => $moved['invitations'],
        ]);
    }

    /** §6.4 `staff.role_changed` meta: role names from/to plus role ids. @return array<string, mixed> */
    public static function roleChangeMeta(Role $from, Role $to): array
    {
        return [
            'changes' => ['role' => ['from' => $from->name, 'to' => $to->name]],
            'role_id' => ['from' => $from->id, 'to' => $to->id],
        ];
    }

    private function writePermissions(Role $role, PermissionSet $permissions): void
    {
        DB::table('role_permissions')->where('tenant_id', $role->tenant_id)->where('role_id', $role->id)->delete();
        $now = now();
        $rows = array_map(fn (string $key) => [
            'tenant_id' => $role->tenant_id, 'role_id' => $role->id, 'permission' => $key, 'created_at' => $now,
        ], $permissions->keys());
        if ($rows !== []) {
            DB::table('role_permissions')->insert($rows);
        }
    }

    private static function cleanDescription(mixed $value): ?string
    {
        $value = is_string($value) ? trim($value) : null;

        return $value === '' ? null : $value;
    }

    /**
     * The U(tenant_id, lower(name)) index is the last word on a concurrent duplicate name → 422 like the pre-check.
     *
     * @template T
     *
     * @param  callable(): T  $fn
     * @return T
     */
    private function unique(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (QueryException $e) {
            if (in_array($e->getCode(), ['23505', '23000'], true) && str_contains($e->getMessage(), 'name')) {
                throw ValidationException::withMessages(['name' => ['A role with this name already exists.']]);
            }
            throw $e;
        }
    }

    private function tenant(): Tenant
    {
        return $this->context->tenant() ?? throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
    }
}
