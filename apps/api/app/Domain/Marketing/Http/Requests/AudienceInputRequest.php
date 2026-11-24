<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Requests;

use App\Domain\Marketing\Models\Campaign;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** AudiencePreviewInput / CampaignEstimateInput (PHASE-8-5 §3.3, §6.1). */
class AudienceInputRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $estimate = $this->routeIs('stores.campaigns.estimate');

        return [
            'channel' => ['required', 'string', Rule::in(Campaign::CHANNELS)],
            'audience' => ['required', 'array'],
            'language' => [$estimate ? 'required' : 'exclude', 'string', Rule::in(Campaign::LANGUAGES)],
            'body' => [$estimate ? 'present' : 'exclude', 'nullable', 'string', 'max:5000'],
            'subject' => [$estimate ? 'sometimes' : 'exclude', 'nullable', 'string', 'max:150', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'coupon_id' => [$estimate ? 'sometimes' : 'exclude', 'nullable', 'string', 'ulid'],
            'product_id' => [$estimate ? 'sometimes' : 'exclude', 'nullable', 'string', 'ulid'],
        ];
    }
}
