<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Base of every purchasing write (PHASE-8-8B §2.2, P88B-12, S169): the plan must include `purchasing`, else 402
 * `feature_not_in_plan` BEFORE body validation (authorize() runs first). The `perm:` middleware already ran.
 */
abstract class PurchasingWriteRequest extends FormRequest
{
    public const DATE_MIN = '2020-01-01';

    public function authorize(): bool
    {
        FeatureGate::assertAllows(app(TenantContext::class)->tenant(), Feature::Purchasing);

        return true;
    }

    /** Plain single-line text: no control characters. */
    protected static function line(int $max): array
    {
        return ['nullable', 'string', "max:{$max}", 'regex:/^[^\x00-\x1F\x7F]*$/u'];
    }

    /** Multi-line text (newlines and tabs allowed). */
    protected static function text(int $max): array
    {
        return ['nullable', 'string', "max:{$max}", 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u'];
    }
}
