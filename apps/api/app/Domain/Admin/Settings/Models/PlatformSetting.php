<?php

declare(strict_types=1);

namespace App\Domain\Admin\Settings\Models;

use App\Domain\Identity\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-1 amendment A1-2: one platform setting (platform table, no tenant_id, no RLS). Read through
 * PlatformSettings (cached), never directly.
 *
 * @property string $key
 * @property mixed $value
 * @property string|null $updated_by
 * @property Carbon|null $updated_at
 * @property-read User|null $updater
 */
class PlatformSetting extends Model
{
    public const CREATED_AT = null;

    protected $table = 'platform_settings';

    protected $primaryKey = 'key';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['key', 'value', 'updated_by'];

    protected function casts(): array
    {
        return ['value' => 'json', 'updated_at' => 'datetime'];
    }

    /** @return BelongsTo<User, $this> */
    public function updater(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
