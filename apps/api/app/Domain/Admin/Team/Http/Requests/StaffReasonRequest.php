<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** Every admin write takes `reason` (5–500 chars, trimmed; PHASE-8-1 conventions). */
class StaffReasonRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['reason' => ['required', 'string', 'min:5', 'max:500']];
    }
}
