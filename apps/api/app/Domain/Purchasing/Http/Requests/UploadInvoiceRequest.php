<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\PurchaseInvoices;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Validator;

/** POST /stores/{store}/purchasing/invoices (PHASE-8-8B §8.1, S176): multipart `file`, sniffed like expense receipts. */
class UploadInvoiceRequest extends PurchasingWriteRequest
{
    /** @var array{mime: string, width: int, height: int}|null */
    public ?array $inspected = null;

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
            $result = app(PurchaseInvoices::class)->inspect($file);
            if (is_string($result)) {
                $validator->errors()->add('file', $result);
            } else {
                $this->inspected = $result;
            }
        }];
    }
}
