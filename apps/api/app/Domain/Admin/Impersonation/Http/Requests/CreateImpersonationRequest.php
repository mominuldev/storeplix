<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /admin/tenants/{tenant}/impersonations `{reason, ticket_ref?}` (PHASE-8-1 §6.5, conventions "Reason"). */
class CreateImpersonationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // `platform.can:impersonate` on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'reason' => ['required', 'string', 'min:5', 'max:500'],
            'ticket_ref' => ['nullable', 'string', 'max:64'],
        ];
    }
}
