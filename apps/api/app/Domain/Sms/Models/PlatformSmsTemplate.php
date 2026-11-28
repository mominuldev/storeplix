<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Identity\Models\User;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §3.1: a custom bn/en body of an editable platform SMS type (defaults live in resources/sms/platform).
 *
 * @property string $id
 * @property string $type
 * @property string $language
 * @property string $body
 * @property int $revision
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PlatformSmsTemplate extends Model
{
    use HasUlids;

    protected $fillable = ['type', 'language', 'body', 'revision', 'updated_by'];

    protected function casts(): array
    {
        return ['revision' => 'integer'];
    }

    /** @return BelongsTo<User, $this> */
    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
