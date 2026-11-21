<?php

namespace App\Domain\Navigation\Models;

use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $handle
 * @property string $title
 * @property list<array<string, mixed>> $items
 * @property int $revision
 * @property string|null $updated_by
 * @property Carbon $updated_at
 */
class StoreNavigation extends Model
{
    use BelongsToTenant, HasUlids;

    protected $table = 'store_navigation';

    public const HANDLES = ['main', 'footer', 'help'];

    public const TITLES = ['main' => 'Main menu', 'footer' => 'Shop', 'help' => 'Help'];

    protected $fillable = ['store_id', 'handle', 'title', 'items', 'revision', 'updated_by'];

    protected $attributes = ['items' => '[]', 'revision' => 1];

    protected function casts(): array
    {
        return ['items' => 'array', 'revision' => 'integer'];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
