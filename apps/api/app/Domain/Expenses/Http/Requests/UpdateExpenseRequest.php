<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** PATCH /stores/{store}/expenses/{expense} (PHASE-8-7 §8.3): any subset of ExpenseInput. */
class UpdateExpenseRequest extends FormRequest
{
    use ExpenseRules;

    public function rules(): array
    {
        return $this->expenseRules(false);
    }
}
