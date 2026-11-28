<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST / PATCH saved replies (PHASE-8-8E §8.1): InboxSavedReplyInput / UpdateInboxSavedReplyInput. */
class SavedReplyRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        foreach (['title', 'body', 'shortcut'] as $key) {
            if (is_string($this->input($key))) {
                $this->merge([$key => trim((string) $this->input($key))]);
            }
        }
        if (is_string($this->input('shortcut'))) {
            $this->merge(['shortcut' => ltrim((string) $this->input('shortcut'), '/')]);
        }
    }

    public function rules(): array
    {
        $create = $this->isMethod('POST');
        $req = $create ? 'required' : 'sometimes';

        return [
            'title' => [$req, 'string', 'min:1', 'max:60'],
            'shortcut' => [$req, 'string', 'regex:/^[a-z0-9_-]{2,24}$/'],
            'body' => [$req, 'string', 'min:1', 'max:1000'],
            'show_as_chip' => ['sometimes', 'boolean'],
            'attachment_id' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'revision' => [$create ? 'prohibited' : 'required', 'integer', 'min:1'],
        ];
    }
}
