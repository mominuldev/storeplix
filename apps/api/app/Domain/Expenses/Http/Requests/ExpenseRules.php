<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Requests;

use App\Domain\Expenses\ExpenseCategory;
use App\Domain\Expenses\ExpenseService;
use App\Domain\Expenses\PaidFrom;
use App\Domain\Stores\Models\Store;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-7 §8.3 shared by StoreExpenseRequest / UpdateExpenseRequest. Unknown fields are ignored (only `validated()`
 * reaches the service); `note` is trimmed and empty → null; control characters are refused.
 */
trait ExpenseRules
{
    public function authorize(): bool
    {
        return true; // perm:expenses.manage on the route; {store} resolves inside the tenant
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('note'))) {
            $note = trim($this->input('note'));
            $this->merge(['note' => $note === '' ? null : $note]);
        }
        if (is_string($this->input('receipt_id'))) {
            $this->merge(['receipt_id' => strtolower($this->input('receipt_id'))]);
        }
    }

    /** @return array<string, mixed> */
    protected function expenseRules(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';
        /** @var Store $store */
        $store = $this->route('store');
        $today = ExpenseService::today($store);

        return [
            'amount' => [$req, 'integer:strict', 'min:1', 'max:1000000000'],
            'category' => [$req, 'string', Rule::in(ExpenseCategory::values())],
            'paid_from' => [$req, 'string', Rule::in(PaidFrom::values())],
            'spent_on' => [$req, 'string', 'date_format:Y-m-d', 'after_or_equal:2020-01-01', 'before_or_equal:'.$today],
            'note' => ['sometimes', 'nullable', 'string', 'max:200', 'not_regex:/[\x00-\x1F\x7F]/'],
            'receipt_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'repeat_monthly' => ['sometimes', 'boolean:strict'],
            'currency' => ['sometimes', 'string', 'size:3', Rule::in([strtoupper((string) $store->currency)])],
        ];
    }

    public function messages(): array
    {
        return [
            'spent_on.before_or_equal' => 'The date can’t be in the future. Use “Repeat every month” for planned costs.',
            'spent_on.after_or_equal' => 'The date must be on or after 1 Jan 2020.',
            'currency.in' => 'The currency must be your shop’s currency.',
        ];
    }
}
