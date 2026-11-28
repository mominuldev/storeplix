<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A member's read position in a conversation (PHASE-8-8E P88E-9).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $conversation_id
 * @property string $user_id
 * @property string $last_read_message_id
 * @property Carbon $read_at
 */
class InboxRead extends Model
{
    use BelongsToTenant, HasUlids;

    public $timestamps = false;

    protected $table = 'inbox_reads';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['read_at' => 'datetime'];
    }
}
