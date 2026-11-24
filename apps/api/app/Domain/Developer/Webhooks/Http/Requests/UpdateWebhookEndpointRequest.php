<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Requests;

use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Developer\Webhooks\WebhookEventType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** UpdateWebhookEndpointInput (every field optional). The plan check (402) runs before validation (P84-13). */
class UpdateWebhookEndpointRequest extends FormRequest
{
    public function authorize(): bool
    {
        app(WebhookEndpoints::class)->assertFeature();

        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'url' => ['sometimes', 'string', 'max:2048'],
            'events' => ['sometimes', 'array', 'min:1', 'max:'.count(WebhookEventType::subscribable())],
            'events.*' => ['required', 'string', 'distinct', Rule::in(WebhookEventType::subscribableValues())],
            'description' => ['sometimes', 'nullable', 'string', 'max:120'],
            'is_active' => ['sometimes', 'boolean:strict'],
        ];
    }

    /** @return array{url?: string, events?: list<string>, description?: string|null, is_active?: bool} */
    public function changes(): array
    {
        $v = $this->validated();
        $out = [];
        if (array_key_exists('url', $v)) {
            $out['url'] = trim((string) $v['url']);
        }
        if (array_key_exists('events', $v)) {
            $out['events'] = array_values($v['events']);
        }
        if (array_key_exists('description', $v)) {
            $out['description'] = StoreWebhookEndpointRequest::blankToNull($v['description']);
        }
        if (array_key_exists('is_active', $v)) {
            $out['is_active'] = (bool) $v['is_active'];
        }

        return $out;
    }
}
