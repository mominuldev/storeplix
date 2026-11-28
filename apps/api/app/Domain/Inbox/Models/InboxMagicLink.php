<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * The reply-SMS link `/m/{code}` (PHASE-8-8E P88E-12): 7 days, ≤ 20 uses, code stored as sha256.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $conversation_id
 * @property string $code_hash
 * @property int $uses
 * @property Carbon $expires_at
 * @property Carbon $created_at
 */
class InboxMagicLink extends Model
{
    use BelongsToTenant, HasUlids;

    public const MAX_USES = 20;

    public const UPDATED_AT = null;

    protected $table = 'inbox_magic_links';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['uses' => 'integer', 'expires_at' => 'datetime'];
    }
}
