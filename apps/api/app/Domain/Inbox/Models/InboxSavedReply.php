<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Carbon;

/**
 * Team-shared saved reply (PHASE-8-8E §8, P88E-8).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $title
 * @property string $shortcut
 * @property string $body
 * @property bool $show_as_chip
 * @property int $position
 * @property int $use_count
 * @property Carbon|null $last_used_at
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class InboxSavedReply extends Model
{
    use BelongsToTenant, HasUlids;

    public const MAX = 200;

    protected $table = 'inbox_saved_replies';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['show_as_chip' => 'boolean', 'position' => 'integer', 'use_count' => 'integer', 'last_used_at' => 'datetime', 'revision' => 'integer'];
    }

    public function attachment(): HasOne
    {
        return $this->hasOne(InboxAttachment::class, 'saved_reply_id');
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
