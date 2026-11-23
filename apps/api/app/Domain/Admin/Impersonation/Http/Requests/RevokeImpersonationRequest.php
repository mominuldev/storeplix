<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /admin/impersonations/{impersonation}/revoke `{reason}` (PHASE-8-1 §6.5). */
class RevokeImpersonationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // `platform.can:suspend` on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['reason' => ['required', 'string', 'min:5', 'max:500']];
    }
}
