<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One "Was this helpful?" vote per member per guide (PHASE-8-9C P89C-9). `tenant_id` is the voter's shop for staff
 * stats only (not an RLS owner).
 *
 * @property string $id
 * @property string $article_id
 * @property string $user_id
 * @property string|null $tenant_id
 * @property string $language
 * @property bool $helpful
 * @property string|null $reason
 * @property string|null $note
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class HelpArticleFeedback extends Model
{
    use HasUlids;

    public const REASONS = ['steps_mismatch', 'hard_to_follow', 'out_of_date', 'not_my_question'];

    protected $table = 'help_article_feedback';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['helpful' => 'boolean'];
    }
}
