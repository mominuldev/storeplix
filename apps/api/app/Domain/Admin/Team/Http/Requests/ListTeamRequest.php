<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Requests;

use App\Domain\Admin\Authorization\PlatformRole;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class ListTeamRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'string', Rule::in(['all', 'active', 'invited', 'disabled'])],
            'filter.role' => ['sometimes', 'string', Rule::enum(PlatformRole::class)],
            'filter.q' => ['sometimes', 'nullable', 'string', 'max:100'],
        ];
    }
}
