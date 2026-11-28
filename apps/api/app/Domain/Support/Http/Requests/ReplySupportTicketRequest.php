<?php

declare(strict_types=1);

namespace App\Domain\Support\Http\Requests;

use App\Domain\Support\SupportAttachments;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** POST /help/tickets/{ticket}/messages and POST /admin/support/tickets/{ticket}/messages (PHASE-8-9C §8.2, §9). */
class ReplySupportTicketRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $rules = [
            'body' => ['required', 'string', 'max:5000'],
            'attachment_ids' => ['sometimes', 'nullable', 'array', 'max:'.SupportAttachments::MAX_PER_MESSAGE],
            'attachment_ids.*' => ['string', 'size:26'],
            'client_id' => ['required', 'uuid'],
        ];
        if ($this->routeIs('admin.*')) {
            $rules['kind'] = ['required', Rule::in(['reply', 'note'])];
            $rules['status'] = ['sometimes', 'nullable', Rule::in(['awaiting_merchant', 'awaiting_support', 'resolved']), Rule::prohibitedIf(fn () => $this->input('kind') === 'note' && $this->input('status') !== null)];
        }

        return $rules;
    }
}
