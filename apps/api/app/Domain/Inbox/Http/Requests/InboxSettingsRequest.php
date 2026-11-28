<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Requests;

use App\Domain\Inbox\Models\InboxSetting;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** PATCH /stores/{store}/inbox/settings (PHASE-8-8E §4): UpdateInboxSettingsInput. */
class InboxSettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'revision' => ['required', 'integer', 'min:1'],
            'web_chat_enabled' => ['sometimes', 'boolean'],
            'order_messages_enabled' => ['sometimes', 'boolean'],
            'email_enabled' => ['sometimes', 'boolean'],
            'widget_reply_time' => ['sometimes', Rule::in(InboxSetting::REPLY_TIMES)],
            'widget_hours' => ['sometimes', 'nullable', 'string', 'max:40'],
            'widget_greeting' => ['sometimes', 'nullable', 'string', 'max:200'],
        ];
    }
}
