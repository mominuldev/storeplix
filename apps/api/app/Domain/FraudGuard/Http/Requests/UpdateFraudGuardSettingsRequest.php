<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Requests;

use App\Domain\FraudGuard\GuardSettings;
use App\Domain\FraudGuard\Models\FraudGuardSetting;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * PATCH …/fraud-guard/settings (PHASE-8-8 §8.3): partial; every key optional (`{enabled: false}` alone is valid);
 * integers in the §4 ranges; `advance_below ≥ hold_below` against the stored value when only one is sent.
 * Unknown keys are refused (never `$request->all()`).
 */
class UpdateFraudGuardSettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:fraud.manage on the route; plan checked in the controller (402 before 422)
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $rules = [];
        foreach (FraudGuardSetting::BOOLEANS as $key) {
            $rules[$key] = ['sometimes', 'boolean:strict'];
        }

        return $rules + [
            'hold_below' => ['sometimes', 'integer:strict', 'between:1,100'],
            'advance_below' => ['sometimes', 'integer:strict', 'between:1,100'],
            'advance_expiry_minutes' => ['sometimes', 'integer:strict', Rule::in(GuardSettings::EXPIRY_MINUTES)],
            'block_after_returns' => ['sometimes', 'integer:strict', 'between:1,20'],
            'duplicate_window_hours' => ['sometimes', 'integer:strict', Rule::in(GuardSettings::WINDOW_HOURS)],
            'daily_limit' => ['sometimes', 'integer:strict', 'between:1,50'],
            'min_parcels' => ['sometimes', 'integer:strict', 'between:1,20'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $v): void {
            foreach (array_diff(array_keys($this->all()), array_keys(GuardSettings::defaults())) as $unknown) {
                $v->errors()->add((string) $unknown, 'This field is not allowed.');
            }
            if ($v->errors()->isNotEmpty()) {
                return;
            }
            /** @var Store $store */
            $store = $this->route('store');
            $current = app(GuardSettings::class)->for($store->id);
            $hold = (int) ($this->input('hold_below') ?? $current->hold_below);
            $advance = (int) ($this->input('advance_below') ?? $current->advance_below);
            if ($advance < $hold) {
                $v->errors()->add($this->has('advance_below') ? 'advance_below' : 'hold_below', 'The advance line must be at or above the hold line.');
            }
        }];
    }
}
