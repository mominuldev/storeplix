<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Requests;

use App\Domain\Admin\Authorization\PlatformRole;
use Illuminate\Validation\Rule;

/** PATCH /admin/team/members/{user} `{role, reason}`. */
class ChangeStaffRoleRequest extends StaffReasonRequest
{
    public function rules(): array
    {
        return parent::rules() + ['role' => ['required', 'string', Rule::enum(PlatformRole::class)]];
    }
}
