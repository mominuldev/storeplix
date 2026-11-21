<?php

namespace App\Domain\Pages\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
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
 * @property string $title
 * @property string $slug
 * @property string $status
 * @property string $template
 * @property list<array<string, mixed>> $body
 * @property string|null $seo_title
 * @property string|null $seo_description
 * @property string|null $og_image_media_id
 * @property int $revision
 * @property Carbon|null $published_at
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property Carbon $updated_at
 * @property-read User|null $updatedBy
 * @property-read Media|null $ogImage
 */
class StorePage extends Model
{
    use BelongsToTenant, HasUlids;

    public const DRAFT = 'draft';

    public const PUBLISHED = 'published';

    public const HIDDEN = 'hidden';

    public const STATUSES = [self::DRAFT, self::PUBLISHED, self::HIDDEN];

    public const MAX_PER_STORE = 50;

    public const SLUG_PATTERN = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    public const RESERVED_SLUGS = [
        'new', 'edit', 'index', 'home', 'api', 'admin', 'search', 'cart', 'checkout', 'account', 'accounts', 'login',
        'logout', 'register', 'collections', 'products', 'orders', 'track', 'track-order', 'sitemap', 'robots', 'preview',
        'pages', 'static', 'assets', 'themes', '_next',
    ];

    protected $fillable = [
        'store_id', 'title', 'slug', 'status', 'template', 'body', 'seo_title', 'seo_description', 'og_image_media_id',
        'revision', 'published_at', 'created_by', 'updated_by',
    ];

    protected $attributes = ['status' => self::DRAFT, 'template' => 'blank', 'body' => '[]', 'revision' => 1];

    protected function casts(): array
    {
        return [
            'body' => 'array',
            'revision' => 'integer',
            'published_at' => 'datetime',
        ];
    }

    public function isPublished(): bool
    {
        return $this->status === self::PUBLISHED;
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }

    public function ogImage(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'og_image_media_id');
    }
}
