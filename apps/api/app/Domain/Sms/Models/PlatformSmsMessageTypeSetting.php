<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §3.1 `platform_sms_message_types`: the on/off switch per platform SMS type (locked types forced on in code).
 *
 * @property string $type
 * @property bool $enabled
 * @property string|null $updated_by
 * @property Carbon|null $updated_at
 */
class PlatformSmsMessageTypeSetting extends Model
{
    public const CREATED_AT = null;

    protected $table = 'platform_sms_message_types';

    protected $primaryKey = 'type';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['type', 'enabled', 'updated_by', 'updated_at'];

    protected function casts(): array
    {
        return ['enabled' => 'boolean', 'updated_at' => 'datetime'];
    }
}
