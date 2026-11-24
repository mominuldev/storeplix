<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Requests;

use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;

/** POST …/fraud-guard/blocked-numbers (PHASE-8-8 §8.3): a BD mobile; note ≤ 200, no control characters. */
class BlockNumberRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:fraud.manage on the route
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('note'))) {
            $note = trim($this->input('note'));
            $this->merge(['note' => $note === '' ? null : $note]);
        }
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'phone' => ['required', 'string', 'max:20', PhoneRule::bdMobile()],
            'note' => ['sometimes', 'nullable', 'string', 'max:200', 'not_regex:/[\x00-\x1F\x7F]/'],
        ];
    }
}
