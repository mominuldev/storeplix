<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Identity\Models\User;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;

/**
 * `notify_team` recipients (P86-19, S138), resolved at send time inside the tenant: the owner, admins and members whose
 * resolved permissions hold the recipe's permission. A removed member is no longer a member, so stops receiving.
 */
final class TeamRecipients
{
    /** @return list<string> distinct emails */
    public static function for(Permission $permission): array
    {
        $tenantId = app(TenantContext::class)->requireId();
        $members = TenantUser::query()->forTenant($tenantId)->with(['roleModel', 'user'])->get();
        $emails = [];
        foreach ($members as $member) {
            /** @var User|null $user */
            $user = $member->user;
            if ($user === null || $user->email === null || filter_var($user->email, FILTER_VALIDATE_EMAIL) === false) {
                continue;
            }
            $allowed = in_array($member->role, [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN], true)
                || ($member->roleModel !== null && RolePermissions::for($member->roleModel)->has($permission));
            if ($allowed) {
                $emails[mb_strtolower($user->email)] = true;
            }
        }

        return array_keys($emails);
    }
}
