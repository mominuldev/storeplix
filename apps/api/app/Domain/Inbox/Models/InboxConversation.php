<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One conversation per contact per channel thread (PHASE-8-8E P88E-2). Store-scoped [S]. Created only through
 * ConversationService::lockOrCreate (race-free on the thread unique key).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $channel
 * @property string $thread_key
 * @property string $status
 * @property string $identity
 * @property string|null $assignee_id
 * @property string|null $customer_id
 * @property string|null $order_id
 * @property string $contact_name
 * @property string|null $contact_phone
 * @property string|null $contact_email
 * @property string|null $subject
 * @property array<string, mixed>|null $context
 * @property string|null $source_path
 * @property string $preview
 * @property Carbon $last_message_at
 * @property string|null $last_customer_message_id
 * @property Carbon|null $last_customer_message_at
 * @property Carbon|null $first_response_at
 * @property string|null $last_inbound_message_id
 * @property Carbon|null $reply_sms_sent_at
 * @property Carbon|null $customer_seen_at
 * @property Carbon|null $closed_at
 * @property string|null $closed_by
 * @property Carbon|null $blocked_at
 * @property string|null $blocked_by
 * @property int $messages_count
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class InboxConversation extends Model
{
    use BelongsToTenant, HasUlids;

    public const WEB_CHAT = 'web_chat';

    public const ORDER = 'order';

    public const EMAIL = 'email';

    public const CHANNELS = [self::WEB_CHAT, self::ORDER, self::EMAIL];

    public const OPEN = 'open';

    public const PENDING = 'pending';

    public const CLOSED = 'closed';

    public const STATUSES = [self::OPEN, self::PENDING, self::CLOSED];

    public const VERIFIED_PHONE = 'verified_phone';

    public const ORDER_ACCESS = 'order_access';

    public const IDENTITY_EMAIL = 'email';

    public const EMAIL_UNVERIFIED = 'email_unverified';

    public const UNVERIFIED = 'unverified';

    protected $table = 'inbox_conversations';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'context' => 'array', 'last_message_at' => 'datetime', 'last_customer_message_at' => 'datetime',
            'first_response_at' => 'datetime', 'reply_sms_sent_at' => 'datetime', 'customer_seen_at' => 'datetime',
            'closed_at' => 'datetime', 'blocked_at' => 'datetime', 'messages_count' => 'integer', 'revision' => 'integer',
        ];
    }

    public function isBlocked(): bool
    {
        return $this->blocked_at !== null;
    }

    /** Reply SMS / magic links only to a proven number (P88E-12, S239). */
    public function textable(): bool
    {
        return in_array($this->identity, [self::VERIFIED_PHONE, self::ORDER_ACCESS], true) && $this->contact_phone !== null
            && in_array($this->channel, [self::WEB_CHAT, self::ORDER], true);
    }

    public function assignee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assignee_id');
    }

    public function closedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'closed_by');
    }
}
