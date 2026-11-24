<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Counts\Http;

use App\Domain\Inventory\Models\StockCount;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Every stock-count write (PHASE-8-8C §8, §9), rules by route: start {location_id, name?, category_id?}; scan {code}
 * (trimmed, 1–64 chars, S193); set-line {counted (null = un-count), revision?}; finish {zero_uncounted, revision?};
 * cancel {revision?}. `perm:inventory.adjust` already ran; no plan gate (P88C-13).
 */
class StockCountRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if ($this->action() === 'scan' && is_string($this->input('code'))) {
            $this->merge(['code' => trim((string) $this->input('code'))]);
        }
    }

    public function rules(): array
    {
        $revision = ['sometimes', 'nullable', 'integer:strict', 'min:1'];

        return match ($this->action()) {
            'store' => [
                'location_id' => ['required', 'string', 'size:26'],
                'name' => ['sometimes', 'nullable', 'string', 'max:80', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
                'category_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            ],
            'scan' => ['code' => ['required', 'string', 'min:1', 'max:64']],
            'update' => [
                'counted' => ['present', 'nullable', 'integer:strict', 'min:0', 'max:'.StockCount::MAX_COUNTED],
                'revision' => $revision,
            ],
            'finish' => ['zero_uncounted' => ['required', 'boolean:strict'], 'revision' => $revision],
            default => ['revision' => $revision],
        };
    }

    public function revision(): ?int
    {
        $value = $this->input('revision');

        return is_int($value) ? $value : null;
    }

    private function action(): string
    {
        $name = (string) $this->route()?->getName();

        return substr($name, (int) strrpos($name, '.') + 1);
    }
}
