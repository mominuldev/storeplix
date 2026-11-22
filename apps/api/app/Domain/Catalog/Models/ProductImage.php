<?php

namespace App\Domain\Catalog\Models;

use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $product_id
 * @property string $media_id
 * @property int $position
 * @property string|null $alt
 * @property-read Media|null $media
 */
class ProductImage extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = ['media_id', 'position', 'alt'];

    protected function casts(): array
    {
        return ['position' => 'integer'];
    }

    public function media(): BelongsTo
    {
        return $this->belongsTo(Media::class);
    }
}
