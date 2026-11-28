<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Requests;

use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\Models\InboxMessage;
use Illuminate\Foundation\Http\FormRequest;

/** POST …/conversations/{c}/messages (PHASE-8-8E §6.2): SendInboxMessageInput. Attachments are resolved in the store. */
class SendInboxMessageRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('body'))) {
            $this->merge(['body' => trim((string) $this->input('body'))]);
        }
        if ($this->input('body') === null && $this->has('body')) {
            $this->merge(['body' => '']);
        }
    }

    public function rules(): array
    {
        return [
            'kind' => ['required', 'string', 'in:reply,note'],
            'body' => ['present', 'string', 'max:'.InboxMessage::BODY_MAX],
            'attachment_ids' => ['sometimes', 'array', 'max:'.InboxAttachments::MAX_PER_MESSAGE],
            'attachment_ids.*' => ['string', 'distinct', 'regex:/^[0-9A-Za-z]{26}$/'],
            'client_id' => ['required', 'string', 'uuid'],
            'saved_reply_id' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
        ];
    }
}
