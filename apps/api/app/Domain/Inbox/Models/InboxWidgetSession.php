<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A website-chat session (PHASE-8-8E §9, P88E-10/11/14): the browser holds the 43-character token (cookie `sp_chat`),
 * the row only its sha256. `pending` holds the first message until the SMS code is verified.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $token_hash
 * @property string $name
 * @property string $phone
 * @property string $status
 * @property string|null $code_hash
 * @property Carbon|null $code_sent_at
 * @property int $code_attempts
 * @property int $code_sends
 * @property array<string, mixed>|null $pending_message
 * @property Carbon|null $verified_at
 * @property string|null $conversation_id
 * @property string $ip_hash
 * @property Carbon $last_seen_at
 * @property Carbon $expires_at
 */
class InboxWidgetSession extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING = 'pending';

    public const VERIFIED = 'verified';

    public const UNVERIFIED = 'unverified';

    protected $table = 'inbox_widget_sessions';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'code_sent_at' => 'datetime', 'code_attempts' => 'integer', 'code_sends' => 'integer', 'pending_message' => 'array',
            'verified_at' => 'datetime', 'last_seen_at' => 'datetime', 'expires_at' => 'datetime',
        ];
    }
}
