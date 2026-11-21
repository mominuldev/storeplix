<?php

namespace App\Domain\Themes\Models;

use App\Domain\Identity\Models\User;
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
 * @property string $theme_code
 * @property string $theme_version
 * @property array<string, mixed> $draft_config
 * @property int $draft_revision
 * @property Carbon|null $draft_updated_at
 * @property string|null $draft_updated_by
 * @property array<string, mixed>|null $published_config
 * @property int|null $published_revision
 * @property Carbon|null $published_at
 * @property string|null $published_by
 * @property bool $is_active
 * @property Carbon|null $applied_at
 * @property-read User|null $draftUpdatedBy
 * @property-read User|null $publishedBy
 */
class StoreTheme extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [
        'store_id', 'theme_code', 'theme_version', 'draft_config', 'draft_revision', 'draft_updated_at', 'draft_updated_by',
        'published_config', 'published_revision', 'published_at', 'published_by', 'is_active', 'applied_at',
    ];

    protected $attributes = ['draft_revision' => 1, 'is_active' => false];

    protected function casts(): array
    {
        return [
            'draft_config' => 'array',
            'published_config' => 'array',
            'draft_revision' => 'integer',
            'published_revision' => 'integer',
            'is_active' => 'boolean',
            'draft_updated_at' => 'datetime',
            'published_at' => 'datetime',
            'applied_at' => 'datetime',
        ];
    }

    public function hasUnpublishedChanges(): bool
    {
        return $this->published_config === null || $this->draft_config != $this->published_config;
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function draftUpdatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'draft_updated_by');
    }

    public function publishedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'published_by');
    }
}
