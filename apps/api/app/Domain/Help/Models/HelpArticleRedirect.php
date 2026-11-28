<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * An old slug of a live guide (PHASE-8-9C §3.1): the merchant read answers 200 with `canonical_slug`.
 *
 * @property string $slug
 * @property string $article_id
 */
class HelpArticleRedirect extends Model
{
    public const UPDATED_AT = null;

    public $incrementing = false;

    protected $primaryKey = 'slug';

    protected $keyType = 'string';

    protected $table = 'help_article_redirects';

    protected $fillable = [];
}
