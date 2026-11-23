<?php

namespace App\Domain\Audit\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class ListAuditLogsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('audit.view');
    }

    public function rules(): array
    {
        return [
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'sort' => ['sometimes', 'in:-created_at'],
            // Unknown filter keys → 422.
            'filter' => ['sometimes', 'array:action,actor_id,actor_type,subject_type,subject_id,created_at'],
            'filter.action' => ['sometimes', 'string', 'max:500', 'regex:/^[a-z0-9_.*,]+$/'],
            'filter.actor_id' => ['sometimes', 'string', 'ulid'],
            // P8-QA-1: lets the dashboard list "Store Plix support" actions (platform_user) on their own.
            'filter.actor_type' => ['sometimes', 'string', Rule::in(['user', 'system', 'platform_user'])],
            'filter.subject_type' => ['sometimes', 'string', Rule::in(['store', 'store_settings', 'staff_member', 'staff_invitation', 'media', 'subscription', 'user', 'store_theme', 'store_page', 'store_navigation', 'product', 'category', 'customer', 'data_import', 'data_export'])],
            'filter.subject_id' => ['sometimes', 'string', 'ulid'],
            'filter.created_at' => ['sometimes', 'array:gte,lte'],
            'filter.created_at.gte' => ['sometimes', 'date'],
            'filter.created_at.lte' => ['sometimes', 'date'],
        ];
    }
}
