<?php

declare(strict_types=1);

namespace App\Domain\Support\Http\Requests;

use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\SupportAttachments;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** POST /help/tickets (PHASE-8-9C P89C-14). */
class CreateSupportTicketRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'category' => ['required', Rule::in(SupportTicket::CATEGORIES)],
            'subject' => ['required', 'string', 'min:5', 'max:150'],
            'description' => ['required', 'string', 'min:20', 'max:5000'],
            'priority' => ['sometimes', 'nullable', Rule::in(SupportTicket::MERCHANT_PRIORITIES)],
            'order_id' => ['sometimes', 'nullable', 'string', 'max:26'],
            'attachment_ids' => ['sometimes', 'nullable', 'array', 'max:'.SupportAttachments::MAX_PER_MESSAGE],
            'attachment_ids.*' => ['string', 'size:26'],
            'client_id' => ['required', 'uuid'],
        ];
    }
}
