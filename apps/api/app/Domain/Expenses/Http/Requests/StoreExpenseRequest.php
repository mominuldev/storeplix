<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /stores/{store}/expenses (PHASE-8-7 §8.3): amount, category, paid_from, spent_on required. */
class StoreExpenseRequest extends FormRequest
{
    use ExpenseRules;

    public function rules(): array
    {
        return $this->expenseRules(true);
    }
}
