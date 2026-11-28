<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A guide (PHASE-8-9C P89C-2 – P89C-4): one slug, an English translation (required to publish) and an optional বাংলা
 * one. Only `published` is ever served to merchants. Platform table.
 *
 * @property string $id
 * @property string $slug
 * @property string $category_id
 * @property string $status
 * @property Carbon|null $scheduled_at
 * @property list<string> $related_article_ids
 * @property int $helpful_yes
 * @property int $helpful_no
 * @property Carbon|null $first_published_at
 * @property Carbon|null $last_published_at
 * @property string|null $last_published_by
 * @property Carbon|null $archived_at
 * @property string|null $archived_by
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class HelpArticle extends Model
{
    use HasUlids;

    public const DRAFT = 'draft';

    public const PUBLISHED = 'published';

    public const SCHEDULED = 'scheduled';

    public const ARCHIVED = 'archived';

    public const STATUSES = [self::DRAFT, self::PUBLISHED, self::SCHEDULED, self::ARCHIVED];

    public const LANGUAGES = ['en', 'bn'];

    protected $table = 'help_articles';

    protected $fillable = [];

    protected $attributes = ['status' => self::DRAFT, 'related_article_ids' => '[]', 'helpful_yes' => 0, 'helpful_no' => 0, 'revision' => 1];

    protected function casts(): array
    {
        return [
            'scheduled_at' => 'datetime',
            'related_article_ids' => 'array',
            'helpful_yes' => 'integer',
            'helpful_no' => 'integer',
            'first_published_at' => 'datetime',
            'last_published_at' => 'datetime',
            'archived_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    /** @return HasMany<HelpArticleTranslation, $this> */
    public function translations(): HasMany
    {
        return $this->hasMany(HelpArticleTranslation::class, 'article_id');
    }

    /** @return BelongsTo<HelpCategory, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(HelpCategory::class, 'category_id');
    }

    public function isLive(): bool
    {
        return $this->status === self::PUBLISHED;
    }
}
