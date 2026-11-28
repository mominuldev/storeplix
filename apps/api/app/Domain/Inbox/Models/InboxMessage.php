<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One immutable row of a conversation (PHASE-8-8E §3). `note` and `system` rows are staff-only: every shopper, email
 * and SMS path selects SHOPPER_KINDS explicitly (P88E-6, S236).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $conversation_id
 * @property string $kind
 * @property string|null $author_user_id
 * @property string|null $body
 * @property string|null $system_event
 * @property array<string, mixed>|null $system_meta
 * @property string|null $client_id
 * @property string|null $delivery_status
 * @property string|null $sms_status
 * @property string|null $sms_message_id
 * @property string|null $email_message_id
 * @property string|null $saved_reply_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class InboxMessage extends Model
{
    use BelongsToTenant, HasUlids;

    public const CUSTOMER = 'customer';

    public const REPLY = 'reply';

    public const NOTE = 'note';

    public const SYSTEM = 'system';

    /** The only rows a shopper (widget, order page, email, SMS) may ever see. */
    public const SHOPPER_KINDS = [self::CUSTOMER, self::REPLY];

    public const BODY_MAX = 4000;

    protected $table = 'inbox_messages';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['system_meta' => 'array'];
    }

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_user_id');
    }

    public function attachments(): HasMany
    {
        return $this->hasMany(InboxAttachment::class, 'message_id')->orderBy('id');
    }
}
