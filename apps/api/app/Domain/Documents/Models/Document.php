<?php

namespace App\Domain\Documents\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A generated document (P5B-53): queued → rendering → ready | failed; `expired` after documents:prune.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $kind
 * @property list<string> $order_ids
 * @property string $language
 * @property string $status
 * @property int|null $pages
 * @property string|null $file_path
 * @property int|null $bytes
 * @property string|null $error_code
 * @property Carbon|null $expires_at
 * @property string|null $created_by
 * @property Carbon $created_at
 */
class Document extends Model
{
    use BelongsToTenant, HasUlids;

    public const QUEUED = 'queued';

    public const RENDERING = 'rendering';

    public const READY = 'ready';

    public const FAILED = 'failed';

    public const EXPIRED = 'expired';

    protected $fillable = [];

    protected $attributes = ['status' => self::QUEUED, 'language' => 'en'];

    protected function casts(): array
    {
        return ['order_ids' => 'array', 'pages' => 'integer', 'bytes' => 'integer', 'expires_at' => 'datetime'];
    }

    public function isExpired(): bool
    {
        return $this->status === self::EXPIRED || ($this->status === self::READY && $this->expires_at !== null && $this->expires_at->isPast());
    }
}
