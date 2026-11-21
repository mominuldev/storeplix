<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;

class AuditLogger
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly ?Request $request = null,
    ) {}

    /**
     * @param  array<string, mixed>  $meta
     */
    public function log(string $action, ?Model $subject = null, array $meta = [], ?Authenticatable $actor = null, ?string $tenantId = null): AuditLog
    {
        $actor ??= $this->request?->user();

        return AuditLog::query()->create([
            'tenant_id' => $tenantId ?? $this->context->id(),
            'actor_type' => $actor ? 'user' : 'system',
            'actor_id' => $actor?->getAuthIdentifier(),
            'action' => $action,
            'subject_type' => $subject ? class_basename($subject) : null,
            'subject_id' => $subject?->getKey(),
            'ip' => $this->request?->ip(),
            'meta' => $meta ?: null,
        ]);
    }
}
