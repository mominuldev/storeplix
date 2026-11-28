<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One language of a guide (PHASE-8-9C P89C-4): editable draft fields and a separate published snapshot.
 * "Unpublished changes" = draft_hash ≠ published_hash. `search_vector` (Postgres only) is never loaded.
 *
 * @property string $id
 * @property string $article_id
 * @property string $language
 * @property string $title
 * @property string $summary
 * @property array<string, mixed> $body
 * @property list<string> $keywords
 * @property string $draft_hash
 * @property string|null $published_title
 * @property string|null $published_summary
 * @property array<string, mixed>|null $published_body
 * @property list<string>|null $published_keywords
 * @property string|null $published_hash
 * @property Carbon|null $published_at
 * @property string|null $body_text
 * @property int $word_count
 * @property int $read_minutes
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class HelpArticleTranslation extends Model
{
    use HasUlids;

    /** Columns read everywhere (never `search_vector`). */
    public const COLUMNS = [
        'id', 'article_id', 'language', 'title', 'summary', 'body', 'keywords', 'draft_hash', 'published_title',
        'published_summary', 'published_body', 'published_keywords', 'published_hash', 'published_at', 'body_text',
        'word_count', 'read_minutes', 'created_at', 'updated_at',
    ];

    protected $table = 'help_article_translations';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'body' => 'array',
            'keywords' => 'array',
            'published_body' => 'array',
            'published_keywords' => 'array',
            'published_at' => 'datetime',
            'word_count' => 'integer',
            'read_minutes' => 'integer',
        ];
    }

    public function isPublished(): bool
    {
        return $this->published_hash !== null && $this->published_at !== null;
    }

    public function hasUnpublishedChanges(): bool
    {
        return $this->draft_hash !== $this->published_hash;
    }
}
