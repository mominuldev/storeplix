<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Requests;

use App\Domain\Catalog\Http\Requests\ProductRequest;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\Gate;

/**
 * PHASE-8-4 §3: the merchant ProductRequest (same rules and normalisation) for API-key requests, which have no user:
 * the store check goes through the Gate (ExternalGate evaluates the StorePolicy with the key's context).
 */
class ExternalProductRequest extends ProductRequest
{
    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return Gate::allows('view', $store);
    }
}
