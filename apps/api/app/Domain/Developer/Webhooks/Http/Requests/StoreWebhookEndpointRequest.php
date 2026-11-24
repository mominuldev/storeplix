<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Requests;

use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Developer\Webhooks\WebhookEventType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** CreateWebhookEndpointInput. The plan check (402) runs before validation (P84-13). */
class StoreWebhookEndpointRequest extends FormRequest
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
            'url' => ['required', 'string', 'max:2048'],
            'events' => ['required', 'array', 'min:1', 'max:'.count(WebhookEventType::subscribable())],
            'events.*' => ['required', 'string', 'distinct', Rule::in(WebhookEventType::subscribableValues())],
            'description' => ['sometimes', 'nullable', 'string', 'max:120'],
        ];
    }

    /** @return array{url: string, events: list<string>, description?: string|null} */
    public function endpointInput(): array
    {
        $v = $this->validated();

        return array_filter([
            'url' => trim((string) $v['url']),
            'events' => array_values($v['events']),
        ]) + (array_key_exists('description', $v) ? ['description' => self::blankToNull($v['description'])] : []);
    }

    public static function blankToNull(mixed $value): ?string
    {
        $value = is_string($value) ? trim($value) : null;

        return $value === '' ? null : $value;
    }
}
