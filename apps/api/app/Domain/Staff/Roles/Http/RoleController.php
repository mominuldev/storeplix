<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles\Http;

use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Staff\Roles\RoleService;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-3 §6.1: GET /permissions, GET|POST /roles, GET|PATCH|DELETE /roles/{role}. Every route is `perm:staff.manage`
 * (route middleware); {role} binds inside the current tenant (foreign id → 404). Checks follow the §4 order.
 */
class RoleController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly RoleService $roles,
    ) {}

    public function permissions(): JsonResponse
    {
        return new JsonResponse(['data' => RolePresenter::catalogue()]);
    }

    public function index(Request $request): JsonResponse
    {
        $roles = Role::query()->with('editor')->get();
        $presenter = $this->presenter($request);

        return new JsonResponse(['data' => $presenter->list($roles), 'meta' => $presenter->meta($roles)]);
    }

    public function show(Request $request, Role $role): JsonResponse
    {
        return new JsonResponse(['data' => $this->presenter($request)->detail($role->load('editor'))]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->roles->assertFeature();                                  // N9
        $this->roles->assertCanGrant($request->input('permissions'));   // N1
        $input = $this->validate($request, true);
        $permissions = $this->roles->assertPrerequisites($input['permissions']);

        $role = $this->roles->create($input, $permissions, $request->user());

        return new JsonResponse(['data' => $this->presenter($request)->detail($role->load('editor'))], 201);
    }

    public function update(Request $request, Role $role): JsonResponse
    {
        $this->roles->assertNotSystem($role);                           // N4
        $this->roles->assertNotOwnRole($role);                          // N3
        $this->roles->assertFeature();                                  // N9
        $this->roles->assertHeld(RolePermissions::for($role));          // N2
        $this->roles->assertCanGrant($request->input('permissions'));   // N1
        $input = $this->validate($request, false);
        $permissions = array_key_exists('permissions', $input) ? $this->roles->assertPrerequisites($input['permissions']) : null;

        $role = $this->roles->update($role, $input, $permissions, $request->user());

        return new JsonResponse(['data' => $this->presenter($request)->detail($role->load('editor'))]);
    }

    public function destroy(Request $request, Role $role): Response
    {
        $this->roles->assertNotSystem($role);                           // N4
        $this->roles->assertNotOwnRole($role);                          // N3
        $reassign = $request->query('reassign_to');
        if ($reassign !== null && ! is_string($reassign)) {
            throw ValidationException::withMessages(['reassign_to' => ['The reassign to field must be a role id.']]);
        }
        if (is_string($reassign) && strtolower($reassign) === $role->id) {
            throw ValidationException::withMessages(['reassign_to' => ['Choose a different role.']]);
        }
        $this->roles->assertHeld(RolePermissions::for($role));          // N2 (re-checked on the locked row)
        // N5 / N9 on the target (unknown, foreign or owner → 422; custom without the feature → 402).
        $target = is_string($reassign) ? $this->roles->assignable($reassign, 'reassign_to') : null;
        // SEC-L3: the caller's revision, like PATCH; a stale one → 409 revision_conflict.
        $revision = Validator::make($request->query(), ['revision' => ['required', 'integer', 'min:1']])->validate()['revision'];

        $this->roles->delete($role, $target, (int) $revision);

        return response()->noContent();
    }

    /** @return array<string, mixed> */
    private function validate(Request $request, bool $create): array
    {
        return Validator::make($request->all(), $this->roles->rules($create))->validate();
    }

    private function presenter(Request $request): RolePresenter
    {
        return new RolePresenter($this->context, $this->roles, $request->user()?->getKey());
    }
}
