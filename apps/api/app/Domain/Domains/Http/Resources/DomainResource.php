<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http\Resources;

use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * StoreDomain (PHASE-6 §6) as an API Resource; DomainPresenter holds the field rules.
 *
 * @mixin StoreDomain
 */
class DomainResource extends JsonResource
{
    /** @param array{manage: bool, feature: bool, store_suspended: bool} $ctx */
    public function __construct(StoreDomain $resource, private readonly array $ctx)
    {
        parent::__construct($resource);
    }

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        return DomainPresenter::present($this->resource, $this->ctx);
    }
}
