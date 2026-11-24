<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Requests;

use App\Domain\Expenses\ExpenseReceipts;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Validator;

/** POST /stores/{store}/expenses/receipts (PHASE-8-7 §5.1): multipart `file`, sniffed by ExpenseReceipts::inspect. */
class UploadReceiptRequest extends FormRequest
{
    /** @var array{mime: string, width: int, height: int}|null */
    public ?array $inspected = null;

    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['file' => ['required', 'file']];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            if ($validator->errors()->isNotEmpty()) {
                return;
            }
            /** @var UploadedFile $file */
            $file = $this->file('file');
            $result = app(ExpenseReceipts::class)->inspect($file);
            if (is_string($result)) {
                $validator->errors()->add('file', $result);
            } else {
                $this->inspected = $result;
            }
        }];
    }
}
