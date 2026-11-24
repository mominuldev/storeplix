<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Requests;

use App\Domain\Marketing\Models\Campaign;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * CreateCampaignInput / UpdateCampaignInput (PHASE-8-5 §3.1, §9.1). `send_mode` is not a field (the endpoint picks
 * it); `scheduled_at` is the remembered time. CR/LF in the name or subject → 422 (S123 header injection). The
 * audience is validated by AudienceDefinition, message rules by CampaignService::assertMessage.
 */
class CampaignRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:marketing.manage on the route
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();
        foreach (['name', 'subject'] as $key) {
            if (isset($in[$key]) && is_string($in[$key])) {
                $in[$key] = trim($in[$key]) === '' && $key === 'subject' ? null : trim($in[$key]);
            }
        }
        if (isset($in['body']) && is_string($in['body'])) {
            $in['body'] = trim(str_replace(["\r\n", "\r"], "\n", $in['body']));
        }
        $this->replace($in);
    }

    public function rules(): array
    {
        $create = $this->isMethod('POST');
        $req = $create ? 'required' : 'sometimes';
        $oneLine = 'regex:/^[^\x00-\x1F\x7F]*$/u';

        return [
            'name' => [$req, 'string', 'min:1', 'max:80', $oneLine],
            'channel' => [$req, 'string', Rule::in(Campaign::CHANNELS)],
            'language' => [$req, 'string', Rule::in(Campaign::LANGUAGES)],
            'audience' => [$req, 'array'],
            'body' => [$req, 'string', 'min:1', 'max:5000', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u'],
            'subject' => ['sometimes', 'nullable', 'string', 'min:1', 'max:150', $oneLine],
            'coupon_id' => ['sometimes', 'nullable', 'string', 'ulid'],
            'product_id' => ['sometimes', 'nullable', 'string', 'ulid'],
            'scheduled_at' => ['sometimes', 'nullable', 'date'],
            'revision' => $create ? ['exclude'] : ['required', 'integer'],
        ];
    }

    /** @return array<string, mixed> */
    public function campaignInput(): array
    {
        $input = $this->validated();
        if (array_key_exists('audience', $input)) {
            $input['audience'] = $this->input('audience'); // raw: AudienceDefinition rejects unknown keys
        }
        unset($input['revision']);

        return $input;
    }
}
