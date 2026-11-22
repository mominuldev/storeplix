<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** UpdateGatewayInput { revision, enabled?, is_default? } (PHASE-5B §4.1). */
final class UpdateGatewayRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'revision' => ['required', 'integer:strict', 'min:1'],
            'enabled' => ['sometimes', 'boolean:strict'],
            'is_default' => ['sometimes', 'boolean:strict'],
        ];
    }
}
