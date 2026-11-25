<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Pos\Models\PosRegister;
use Illuminate\Foundation\Http\FormRequest;

/**
 * POST / PATCH …/pos/registers (PosRegisterInput, PHASE-8-8D §4). `perm:settings.manage` already ran. POST needs plan
 * `pos` (402 before validation, P88D-19); PATCH works on every plan. POST requires name and location_id.
 */
class PosRegisterRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->isMethod('POST')) {
            PosPlanGate::assert();
        }

        return true;
    }

    public function rules(): array
    {
        $patch = $this->isMethod('PATCH');

        return [
            'name' => [$patch ? 'sometimes' : 'required', 'string', 'min:1', 'max:'.PosRegister::NAME_MAX, 'regex:/^[^\x00-\x1F\x7F]*$/u', 'regex:/\S/u'],
            'location_id' => [$patch ? 'sometimes' : 'required', 'string', 'size:26'],
            'position' => ['sometimes', 'integer:strict', 'min:0', 'max:1000'],
        ];
    }
}
