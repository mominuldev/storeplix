<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Media\MediaPurpose;
use App\Domain\Sms\Models\SmsSenderId;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * POST /stores/{store}/sms/sender-ids (PHASE-8-9A §8.2, P89A-13, P89A-16): multipart. `sender_id` 3–11 letters/digits
 * with ≥ 1 letter, `business_name` 2–120, `uses[]` 1–3 distinct of order_updates|otp|pos_receipts, `rights_confirmed`
 * ticked, `note` ≤ 300, `document` (trade licence) sniffed with the expense-receipt rules.
 */
class SenderIdRequest extends FormRequest
{
    /** @var array{mime: string, width: int, height: int}|null */
    public ?array $inspected = null;

    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'sender_id' => ['required', 'string', 'regex:'.config('sms.sender_id_pattern')],
            'business_name' => ['required', 'string', 'min:2', 'max:120'],
            'uses' => ['required', 'array', 'min:1', 'max:3'],
            'uses.*' => ['required', 'string', 'distinct', Rule::in(SmsSenderId::USES)],
            'rights_confirmed' => ['required', Rule::in(['1', 'true', 1, true])],
            'note' => ['sometimes', 'nullable', 'string', 'max:300'],
            'document' => ['required', 'file'],
        ];
    }

    public function messages(): array
    {
        return [
            'sender_id.regex' => 'Use 3–11 letters and digits, with at least one letter.',
            'rights_confirmed.required' => 'Confirm that this name belongs to your business.',
            'rights_confirmed.in' => 'Confirm that this name belongs to your business.',
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            if ($validator->errors()->has('document')) {
                return;
            }
            /** @var UploadedFile $file */
            $file = $this->file('document');
            $result = app(ExpenseReceipts::class)->inspect($file, MediaPurpose::SenderIdDocument);
            if (is_string($result)) {
                $validator->errors()->add('document', $result);
            } else {
                $this->inspected = $result;
            }
        }];
    }
}
