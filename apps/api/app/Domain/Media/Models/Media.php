<?php

namespace App\Domain\Media\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $purpose
 * @property string $disk
 * @property string $path
 * @property string $mime
 * @property int $size_bytes
 * @property int $width
 * @property int $height
 * @property string $checksum
 * @property string|null $alt
 * @property string $status
 * @property list<array{key: string, width: int, height: int, mime: string, path: string}> $variants
 * @property string|null $uploaded_by
 */
class Media extends Model
{
    use BelongsToTenant, HasUlids;

    public const PROCESSING = 'processing';

    public const READY = 'ready';

    public const FAILED = 'failed';

    protected $table = 'media';

    protected $fillable = ['purpose', 'disk', 'path', 'mime', 'size_bytes', 'width', 'height', 'checksum', 'alt', 'status', 'variants', 'uploaded_by'];

    protected $attributes = ['status' => self::PROCESSING, 'variants' => '[]'];

    protected function casts(): array
    {
        return [
            'size_bytes' => 'integer',
            'width' => 'integer',
            'height' => 'integer',
            'variants' => 'array',
        ];
    }

    /** @return array{key: string, width: int, height: int, mime: string, path: string}|null */
    public function variant(string $key): ?array
    {
        foreach ($this->variants ?? [] as $variant) {
            if (($variant['key'] ?? null) === $key) {
                return $variant;
            }
        }

        return null;
    }
}
