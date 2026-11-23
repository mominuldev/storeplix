<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /auth/impersonation `{ticket}` (PHASE-8-1 §3.2). Shape errors are 422; any unusable ticket is the same 404. */
class ConsumeImpersonationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['ticket' => ['required', 'string', 'max:128']];
    }
}
