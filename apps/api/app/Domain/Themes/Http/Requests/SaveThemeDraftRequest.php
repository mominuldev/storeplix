<?php

namespace App\Domain\Themes\Http\Requests;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Themes\ThemeConfigValidator;
use App\Domain\Themes\ThemeLimits;
use Illuminate\Foundation\Http\FormRequest;
use stdClass;

/** PUT /stores/{store}/themes/{code}/draft — stage 1 (envelope + 64 KB cap). */
class SaveThemeDraftRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('update', $store);
    }

    public function rules(): array
    {
        return [
            'config' => ['required', 'array'],
            'base_revision' => ['required', 'integer', 'min:1'],
        ];
    }

    /** Called after authorization (ValidatesWhenResolvedTrait): 413 for configs over 64 KB. */
    protected function getValidatorInstance()
    {
        $config = $this->input('config');
        if (is_array($config) && ThemeConfigValidator::byteSize($this->rawConfig() ?? $config) > ThemeLimits::MAX_CONFIG_BYTES) {
            throw new ApiException(413, 'payload_too_large', 'The theme config is larger than 64 KB.');
        }

        return parent::getValidatorInstance();
    }

    /** `config` decoded with objects preserved ({} stays an object), when the body is JSON. */
    public function rawConfig(): ?stdClass
    {
        $decoded = json_decode((string) $this->getContent(), false, 64);

        return $decoded instanceof stdClass && ($decoded->config ?? null) instanceof stdClass ? $decoded->config : null;
    }
}
