<?php

namespace App\Domain\Tenancy\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * Append-only audit trail. tenant_id is nullable (platform events), so this model is
 * not tenant-scoped; tenant-facing reads must filter by tenant_id explicitly.
 */
class AuditLog extends Model
{
    use HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [
        'tenant_id', 'actor_type', 'actor_id', 'action', 'subject_type', 'subject_id', 'ip', 'meta',
    ];

    protected function casts(): array
    {
        return ['meta' => 'array'];
    }
}
