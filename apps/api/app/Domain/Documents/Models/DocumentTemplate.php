<?php

namespace App\Domain\Documents\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Print options of one store × kind (P5B-52). JSON config only, never merchant HTML. Absent row = defaults.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $kind
 * @property array<string, mixed> $config
 * @property int $revision
 * @property string|null $updated_by
 * @property Carbon $updated_at
 */
class DocumentTemplate extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['revision' => 1];

    protected function casts(): array
    {
        return ['config' => 'array', 'revision' => 'integer'];
    }
}
