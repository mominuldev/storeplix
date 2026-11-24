<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\Models\PurchaseOrder;
use Illuminate\Validation\Rule;

/** POST …/{po}/send · mark-ordered · close · cancel (PHASE-8-8B §5.2): optional `revision`; `send` needs `sent_via`. */
class TransitionRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        $send = str_ends_with((string) $this->route()?->getName(), '.send');

        return [
            'revision' => ['sometimes', 'nullable', 'integer:strict', 'min:1'],
            'sent_via' => $send ? ['required', 'string', Rule::in(PurchaseOrder::SENT_VIA)] : ['prohibited'],
        ];
    }
}
