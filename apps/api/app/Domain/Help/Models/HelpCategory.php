<?php

declare(strict_types=1);

namespace App\Domain\Help\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A help topic (PHASE-8-9C P89C-7). Platform table: no tenant, no RLS; staff writes on the platform connection.
 *
 * @property string $id
 * @property string $slug
 * @property string $name_en
 * @property string|null $name_bn
 * @property string|null $description_en
 * @property string|null $description_bn
 * @property string $icon
 * @property int $position
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class HelpCategory extends Model
{
    use HasUlids;

    public const ICONS = ['rocket', 'box', 'cart', 'truck', 'card', 'palette', 'megaphone', 'globe', 'users', 'chart', 'settings', 'message'];

    public const MAX = 30;

    protected $table = 'help_categories';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['position' => 'integer', 'revision' => 'integer'];
    }

    public function name(string $language): string
    {
        return $language === 'bn' && $this->name_bn !== null && $this->name_bn !== '' ? $this->name_bn : $this->name_en;
    }

    public function description(string $language): ?string
    {
        return $language === 'bn' && $this->description_bn !== null && $this->description_bn !== '' ? $this->description_bn : $this->description_en;
    }
}
