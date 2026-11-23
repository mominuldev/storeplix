<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-1 §5.1 `platform_recovery_codes` (platform table).
 *
 * @property string $id
 * @property string $user_id
 * @property string $code_hash
 * @property Carbon|null $used_at
 */
class PlatformRecoveryCode extends Model
{
    use HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = ['user_id', 'code_hash', 'used_at'];

    protected function casts(): array
    {
        return ['used_at' => 'datetime', 'created_at' => 'datetime'];
    }
}
