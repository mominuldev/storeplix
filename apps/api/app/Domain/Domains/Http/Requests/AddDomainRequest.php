<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http\Requests;

use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Foundation\Http\FormRequest;

/** AddDomainInput (S51): `hostname` only; everything else in the body is ignored. Normalisation is HostnameInput. */
class AddDomainRequest extends FormRequest
{
    public function authorize(): bool
    {
        return (bool) $this->user()?->can('create', StoreDomain::class); // 403 before validation (S47)
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'hostname' => ['required', 'string', 'max:300'],
        ];
    }

    public function hostname(): string
    {
        return (string) $this->validated('hostname');
    }
}
