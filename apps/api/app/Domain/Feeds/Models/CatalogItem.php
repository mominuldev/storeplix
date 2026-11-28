<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §3.1: one feed item (a variant) of one feed integration.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $store_integration_id
 * @property string $product_id
 * @property string $variant_id
 * @property string $status
 * @property string|null $review_status
 * @property string|null $excluded_reason
 * @property list<array<string, mixed>> $issues
 * @property string|null $content_hash
 * @property Carbon|null $dirty_at
 * @property Carbon|null $last_synced_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class CatalogItem extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING = 'pending';

    public const SYNCED = 'synced';

    public const ERROR = 'error';

    public const EXCLUDED = 'excluded';

    public const DELETING = 'deleting';

    protected $table = 'catalog_items';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['issues' => 'array', 'dirty_at' => 'datetime', 'last_synced_at' => 'datetime'];
    }
}
