<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers\Http;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;

/**
 * POST …/{transfer}/send · /receive · /cancel and DELETE (PHASE-8-8C §7): optional `revision`; receive needs one entry
 * per line (0 ≤ received ≤ quantity, checked against the lines in the service). Only SEND is plan-gated (P88C-13:
 * an in-transit transfer can still be received or cancelled after a downgrade, S192).
 */
class TransferTransitionRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->action() === 'send') {
            FeatureGate::assertAllows(app(TenantContext::class)->tenant(), Feature::MultiWarehouse);
        }

        return true;
    }

    public function rules(): array
    {
        $receive = $this->action() === 'receive';

        return [
            'revision' => ['sometimes', 'nullable', 'integer:strict', 'min:1'],
            'lines' => $receive ? ['required', 'array', 'min:1', 'max:200'] : ['prohibited'],
            'lines.*' => ['array'],
            'lines.*.item_id' => ['required', 'string', 'size:26'],
            'lines.*.received' => ['required', 'integer:strict', 'min:0', 'max:100000'],
        ];
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
