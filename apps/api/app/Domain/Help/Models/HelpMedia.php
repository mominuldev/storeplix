<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A platform help image (PHASE-8-9C P89C-6): public CDN disk under `platform/help/{id}/`, never a tenant prefix.
 *
 * @property string $id
 * @property string $disk
 * @property string $path
 * @property string $mime
 * @property int $size_bytes
 * @property int $width
 * @property int $height
 * @property list<array{key: string, width: int, height: int, mime: string, path: string}> $variants
 * @property string $status
 * @property string|null $alt
 * @property string|null $uploaded_by
 * @property Carbon $created_at
 */
class HelpMedia extends Model
{
    use HasUlids;

    public const PROCESSING = 'processing';

    public const READY = 'ready';

    public const FAILED = 'failed';

    protected $table = 'help_media';

    protected $fillable = [];

    protected $attributes = ['status' => self::PROCESSING, 'variants' => '[]'];

    protected function casts(): array
    {
        return ['size_bytes' => 'integer', 'width' => 'integer', 'height' => 'integer', 'variants' => 'array'];
    }
}
