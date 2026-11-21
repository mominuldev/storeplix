<?php

namespace App\Domain\Stores\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property array<string, mixed> $theme
 * @property string|null $logo_url
 * @property string|null $favicon_url
 * @property string|null $seo_title
 * @property string|null $seo_description
 */
class StoreSetting extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = ['store_id', 'theme', 'logo_url', 'favicon_url', 'seo_title', 'seo_description'];

    protected function casts(): array
    {
        return ['theme' => 'array'];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
