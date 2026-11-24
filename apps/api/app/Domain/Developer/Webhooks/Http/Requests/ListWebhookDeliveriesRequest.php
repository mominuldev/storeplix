<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Requests;

use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\WebhookEventType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** WebhookDeliveryFilters: filter[endpoint_id|status|event_type], cursor. */
class ListWebhookDeliveriesRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'filter' => ['sometimes', 'array:endpoint_id,status,event_type'],
            'filter.endpoint_id' => ['sometimes', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'filter.status' => ['sometimes', 'string', Rule::in(WebhookDelivery::STATUSES)],
            'filter.event_type' => ['sometimes', 'string', Rule::in(array_map(fn (WebhookEventType $t) => $t->value, WebhookEventType::cases()))],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ];
    }
}
